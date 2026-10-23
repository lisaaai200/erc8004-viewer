// ERC-8004 identity viewer: reads an agent's identity (owner, tokenURI, registration file)
// and its reputation feedback. Plain ES module, no dependency, browser and Node 20.
import { REGISTRIES, NETWORKS, DEFAULT_IPFS_GATEWAY } from './config.js';

export const SELECTORS = {
  ownerOf: '0x6352211e',          // ownerOf(uint256)
  tokenURI: '0xc87b56dd',         // tokenURI(uint256)
  readAllFeedback: '0xd9d84224',  // readAllFeedback(uint256,address[],string,string,bool)
};
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

// ---------- ABI helpers ----------

function strip0x(hex) {
  if (typeof hex !== 'string') throw new Error('hex data must be a string');
  const h = /^0x/i.test(hex) ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('not valid hex data');
  return h.toLowerCase();
}
function hexToBytes(hex) {
  const h = strip0x(hex);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) { let s = '0x'; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; }
const utf8 = new TextDecoder('utf-8');
const utf8enc = new TextEncoder();

function word(b, at) {
  if (at < 0 || at + 32 > b.length) throw new Error('ABI data is too short');
  return b.subarray(at, at + 32);
}
function uint(b, at) { let v = 0n; for (const x of word(b, at)) v = (v << 8n) | BigInt(x); return v; }
function int(b, at) { const v = uint(b, at); return v >= 1n << 255n ? v - (1n << 256n) : v; }
function size(b, at) { const v = uint(b, at); if (v > BigInt(b.length)) throw new Error('ABI offset or length out of range'); return Number(v); }
function address(b, at) { return bytesToHex(word(b, at).subarray(12)); }
function stringAt(b, at) {
  const len = size(b, at);
  if (at + 32 + len > b.length) throw new Error('ABI data is too short');
  return utf8.decode(b.subarray(at + 32, at + 32 + len));
}
function staticArray(b, at, read) { const n = size(b, at); return Array.from({ length: n }, (_, i) => read(b, at + 32 + 32 * i)); }
function stringArray(b, at) { const n = size(b, at); const base = at + 32; return Array.from({ length: n }, (_, i) => stringAt(b, base + size(b, base + 32 * i))); }

function uintWord(n) { const out = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; }
function intWord(n) { let v = BigInt(n); if (v < 0n) v += 1n << 256n; return uintWord(v); }
function pad32(b) { const out = new Uint8Array(Math.ceil(b.length / 32) * 32); out.set(b); return out; }
function concat(parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function encString(s) { const b = utf8enc.encode(s); return concat([uintWord(b.length), pad32(b)]); }
function addrWord(a) { return concat([new Uint8Array(12), hexToBytes(a)]); }
/** Encode a list of [isDynamic, bytes] heads and tails. */
function encodeParams(params) {
  const heads = []; const tails = []; let offset = 32 * params.length;
  for (const [dyn, enc] of params) {
    if (dyn) { heads.push(uintWord(offset)); tails.push(enc); offset += enc.length; } else heads.push(enc);
  }
  return concat([...heads, ...tails]);
}

/** Calldata for ownerOf / tokenURI. */
export function encodeAgentCall(selector, agentId) { return selector + bytesToHex(uintWord(agentId)).slice(2); }

/** Calldata for readAllFeedback(agentId, [], '', '', false): every client, no tag filter, revoked left out. */
export function encodeReadAllFeedback(agentId, clients = [], tag1 = '', tag2 = '', includeRevoked = false) {
  return SELECTORS.readAllFeedback + bytesToHex(encodeParams([
    [false, uintWord(agentId)],
    [true, concat([uintWord(clients.length), ...clients.map(addrWord)])],
    [true, encString(tag1)],
    [true, encString(tag2)],
    [false, uintWord(includeRevoked ? 1 : 0)],
  ])).slice(2);
}

export function decodeAddress(hex) { return address(hexToBytes(hex), 0); }
export function decodeString(hex) { const b = hexToBytes(hex); return stringAt(b, size(b, 0)); }
export function encodeString(s) { return bytesToHex(encodeParams([[true, encString(s)]])); }
export function encodeAddress(a) { return bytesToHex(addrWord(a)); }

/** Decode readAllFeedback's seven parallel arrays into rows. */
export function decodeAllFeedback(hex) {
  const b = hexToBytes(hex);
  const o = (i) => size(b, 32 * i);
  const clients = staticArray(b, o(0), address);
  const indexes = staticArray(b, o(1), (bb, at) => Number(uint(bb, at)));
  const values = staticArray(b, o(2), int);
  const decimals = staticArray(b, o(3), (bb, at) => Number(uint(bb, at)));
  const tag1s = stringArray(b, o(4));
  const tag2s = stringArray(b, o(5));
  const revoked = staticArray(b, o(6), (bb, at) => uint(bb, at) !== 0n);
  const n = clients.length;
  if ([indexes, values, decimals, tag1s, tag2s, revoked].some((a) => a.length !== n)) throw new Error('feedback arrays have different lengths');
  return clients.map((client, i) => ({ client, index: indexes[i], value: values[i], valueDecimals: decimals[i], tag1: tag1s[i], tag2: tag2s[i], revoked: revoked[i] }));
}

/** Encode readAllFeedback's answer (tests and fixtures). rows: {client, index, value, valueDecimals, tag1, tag2, revoked} */
export function encodeAllFeedback(rows) {
  const arr = (words) => concat([uintWord(words.length), ...words]);
  const strArr = (ss) => concat([uintWord(ss.length), encodeParams(ss.map((s) => [true, encString(s)]))]);
  return bytesToHex(encodeParams([
    [true, arr(rows.map((r) => addrWord(r.client)))],
    [true, arr(rows.map((r) => uintWord(r.index)))],
    [true, arr(rows.map((r) => intWord(r.value)))],
    [true, arr(rows.map((r) => uintWord(r.valueDecimals)))],
    [true, strArr(rows.map((r) => r.tag1 ?? ''))],
    [true, strArr(rows.map((r) => r.tag2 ?? ''))],
    [true, arr(rows.map((r) => uintWord(r.revoked ? 1 : 0)))],
  ]));
}

// ---------- URIs ----------

/** Map an agent URI to what to fetch: data: URIs are decoded here, ipfs:// goes to the gateway. */
export function resolveUri(uri, gateway = DEFAULT_IPFS_GATEWAY) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('the agent has an empty tokenURI');
  const u = uri.trim();
  if (/^data:/i.test(u)) {
    const comma = u.indexOf(',');
    if (comma < 0) throw new Error('malformed data: URI');
    const meta = u.slice(5, comma).toLowerCase();
    if (meta && !meta.startsWith('application/json') && !meta.startsWith('text/plain') && meta !== ';base64') {
      throw new Error(`unsupported data: URI type ${meta.split(';')[0]}`);
    }
    const payload = u.slice(comma + 1);
    let text;
    if (meta.split(';').includes('base64')) {
      const bin = atob(payload.replace(/\s+/g, ''));
      text = utf8.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } else {
      text = decodeURIComponent(payload);
    }
    return { kind: 'data', json: JSON.parse(text) };
  }
  if (/^ipfs:\/\//i.test(u)) {
    const path = u.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//, '');
    const base = gateway.endsWith('/') ? gateway : gateway + '/';
    return { kind: 'url', url: base + path };
  }
  if (/^https?:\/\//i.test(u)) return { kind: 'url', url: u };
  throw new Error(`unsupported tokenURI scheme: ${u.slice(0, 40)}`);
}

// ---------- loadAgent ----------

function isRevert(e) {
  if (!e) return false;
  if (e.code === 3 || e.code === '3') return true;
  return /revert/i.test(String(e.message ?? e));
}
function errText(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message) return e.message + (e.code !== undefined ? ` (code ${e.code})` : '');
  return String(e);
}
function toNumber(value, decimals) {
  // value: bigint, decimals 0..18 -> a JS number for display and the average
  const neg = value < 0n; const abs = neg ? -value : value;
  const scale = 10n ** BigInt(Math.min(Math.max(decimals, 0), 18));
  const whole = abs / scale; const frac = abs % scale;
  const s = `${neg ? '-' : ''}${whole}${decimals > 0 ? '.' + frac.toString().padStart(decimals, '0') : ''}`;
  return Number(s);
}

/** Summarise feedback rows (revoked rows left out). */
export function summariseFeedback(rows) {
  const live = rows.filter((r) => !r.revoked);
  const items = live.map((r) => ({
    client: r.client,
    score: toNumber(r.value, r.valueDecimals),
    tags: [r.tag1, r.tag2].filter((t) => t),
    index: r.index,
  }));
  const average = items.length ? Math.round((items.reduce((s, i) => s + i.score, 0) / items.length) * 100) / 100 : null;
  return { count: items.length, average, items };
}

/**
 * Load an agent's identity and reputation.
 * Never throws: status is ok, empty (no such agent) or error (RPC or registration file failed).
 * @param {{agentId: number|string|bigint, network: 'base'|'base-sepolia', identityRegistry?: string, reputationRegistry?: string,
 *   rpc: (method: string, params: unknown[]) => Promise<string>, fetchJson: (url: string) => Promise<unknown>, ipfsGateway?: string}} args
 */
export async function loadAgent(args = {}) {
  const { network, rpc, fetchJson } = args;
  const out = { status: 'error', agentId: null, owner: null, tokenURI: null, registration: null, feedback: null };
  const fail = (error, status = 'error') => ({ ...out, status, error });

  let id;
  try {
    id = BigInt(args.agentId);
    if (id < 0n || id >= 1n << 256n) throw new Error();
  } catch {
    return fail('the agent id must be a whole number of 0 or more');
  }
  out.agentId = id.toString();
  out.network = network;
  const net = NETWORKS[network];
  if (!net) return fail(`unknown network "${network}": use base or base-sepolia`);
  out.chainId = net.chainId;
  const identityRegistry = args.identityRegistry ?? REGISTRIES[network]?.identity;
  const reputationRegistry = args.reputationRegistry;
  if (!/^0x[0-9a-fA-F]{40}$/.test(identityRegistry ?? '')) return fail('the identity registry address is missing or invalid');
  if (typeof rpc !== 'function' || typeof fetchJson !== 'function') return fail('rpc and fetchJson functions are required');
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

  // 1. owner
  try {
    out.owner = decodeAddress(await call(identityRegistry, encodeAgentCall(SELECTORS.ownerOf, id)));
  } catch (e) {
    if (isRevert(e)) return fail(`no agent #${out.agentId} on ${net.name}`, 'empty');
    return fail(`could not read the identity registry on ${net.name}: ${errText(e)}`);
  }
  if (out.owner === ZERO_ADDRESS) { out.owner = null; return fail(`no agent #${out.agentId} on ${net.name}`, 'empty'); }

  // 2. tokenURI
  try {
    out.tokenURI = decodeString(await call(identityRegistry, encodeAgentCall(SELECTORS.tokenURI, id)));
  } catch (e) {
    return fail(`could not read the tokenURI: ${errText(e)}`);
  }

  // 3. registration file
  try {
    const r = resolveUri(out.tokenURI, args.ipfsGateway ?? DEFAULT_IPFS_GATEWAY);
    const json = r.kind === 'data' ? r.json : await fetchJson(r.url);
    if (r.kind === 'url') out.registrationUrl = r.url;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('the registration file is not a JSON object');
    out.registration = normaliseRegistration(json);
  } catch (e) {
    return fail(`could not read the registration file: ${errText(e)}`);
  }

  // 4. reputation (optional)
  if (reputationRegistry) {
    try {
      const rows = decodeAllFeedback(await call(reputationRegistry, encodeReadAllFeedback(id)));
      out.feedback = summariseFeedback(rows);
    } catch (e) {
      return fail(`could not read the reputation registry: ${errText(e)}`);
    }
  }

  out.status = 'ok';
  return out;
}

/** Keep the raw file and pull out what the page shows. Older files use endpoints, newer ones services. */
export function normaliseRegistration(json) {
  const list = Array.isArray(json.services) ? json.services : Array.isArray(json.endpoints) ? json.endpoints : [];
  const endpoints = list.filter((e) => e && typeof e === 'object').map((e) => ({
    name: String(e.name ?? e.type ?? ''),
    endpoint: String(e.endpoint ?? e.url ?? e.uri ?? ''),
    version: e.version !== undefined ? String(e.version) : undefined,
  }));
  return {
    ...json,
    name: typeof json.name === 'string' ? json.name : '',
    description: typeof json.description === 'string' ? json.description : '',
    image: typeof json.image === 'string' ? json.image : '',
    endpoints,
    supportedTrust: Array.isArray(json.supportedTrust) ? json.supportedTrust.map(String) : [],
  };
}

// ---------- fetch based helpers for the page ----------

export function makeRpc(url, fetchFn = (...a) => globalThis.fetch(...a)) {
  let n = 0;
  return async (method, params) => {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) { const e = new Error(j.error.message || 'JSON-RPC error'); e.code = j.error.code; throw e; }
    return j.result;
  };
}

export function makeFetchJson(fetchFn = (...a) => globalThis.fetch(...a)) {
  return async (url) => {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  };
}
