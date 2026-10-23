// Tests for viewer.js, one per acceptance item (A1 to A6). No network: rpc and fetchJson are
// stubs or raw answers recorded from Base and Base Sepolia. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadAgent, SELECTORS, encodeAgentCall, encodeAddress, encodeString, encodeAllFeedback, decodeAllFeedback,
  encodeReadAllFeedback, resolveUri, summariseFeedback, makeRpc, makeFetchJson,
} from '../viewer.js';
import { REGISTRIES, NETWORKS, KOGNAI_TEST_IDENTITY } from '../config.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const abi = read('./fixtures/eth-abi.json');
const recorded = read('./fixtures/recorded-rpc.json');

const ID_REG = REGISTRIES['base-sepolia'].identity;
const REP_REG = REGISTRIES['base-sepolia'].reputation;
const OWNER = '0x460dfacb909637f2e971b15e19727adb4a2adbd2';
const REG_FILE = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Genie', description: 'An openly AI-run agent.', image: 'https://example.com/genie.png',
  services: [{ name: 'A2A', endpoint: 'https://example.com/.well-known/agent-card.json', version: '0.3.0' }, { name: 'MCP', endpoint: 'https://example.com/mcp' }],
  supportedTrust: ['reputation'],
};

/** A fake chain: agents {id: {owner, uri}} and feedback rows per agent. Reverts like OpenZeppelin ERC721. */
function chain(agents, feedback = {}, opts = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(params[0]);
    assert.equal(method, 'eth_call');
    const { to, data } = params[0];
    if (opts.fail) throw opts.fail;
    const id = BigInt('0x' + data.slice(10, 74)).toString();
    if (to === ID_REG) {
      const a = agents[id];
      if (!a) throw Object.assign(new Error('execution reverted: ERC721NonexistentToken'), { code: 3 });
      if (data.startsWith(SELECTORS.ownerOf)) return encodeAddress(a.owner);
      if (data.startsWith(SELECTORS.tokenURI)) return encodeString(a.uri);
    }
    if (to === REP_REG && data.startsWith(SELECTORS.readAllFeedback)) {
      assert.equal(data, encodeReadAllFeedback(BigInt(id)));
      if (opts.repFail) throw opts.repFail;
      return encodeAllFeedback(feedback[id] ?? []);
    }
    throw new Error('unexpected call');
  };
  return { rpc, calls };
}
function files(map) {
  const asked = [];
  return { asked, fetchJson: async (url) => { asked.push(url); if (!(url in map)) throw new Error('HTTP 404'); return structuredClone(map[url]); } };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const base = { network: 'base-sepolia', identityRegistry: ID_REG };

test('A1 an existing agent shows its owner, its tokenURI and its registration file', async () => {
  const { rpc, calls } = chain({ 7: { owner: OWNER, uri: 'https://example.com/agent.json' } });
  const { fetchJson, asked } = files({ 'https://example.com/agent.json': REG_FILE });
  const r = await loadAgent({ ...base, agentId: 7, rpc, fetchJson });
  assert.equal(r.status, 'ok');
  assert.equal(r.agentId, '7');
  assert.equal(r.owner, OWNER);
  assert.equal(r.tokenURI, 'https://example.com/agent.json');
  assert.equal(r.registration.name, 'Genie');
  assert.equal(r.registration.description, 'An openly AI-run agent.');
  assert.equal(r.registration.image, 'https://example.com/genie.png');
  assert.deepEqual(r.registration.endpoints.map((e) => e.name), ['A2A', 'MCP']);
  assert.deepEqual(r.registration.supportedTrust, ['reputation']);
  assert.equal(r.feedback, null, 'no reputation registry given');
  assert.deepEqual(asked, ['https://example.com/agent.json']);
  assert.deepEqual(calls.map((c) => c.data), [encodeAgentCall(SELECTORS.ownerOf, 7n), encodeAgentCall(SELECTORS.tokenURI, 7n)]);
  // older registration files use endpoints instead of services
  const { endpoints, services, ...old } = { ...REG_FILE, endpoints: [{ name: 'ENS', endpoint: 'genie.eth' }] };
  const r2 = await loadAgent({ ...base, agentId: 7, rpc, fetchJson: files({ 'https://example.com/agent.json': { ...old, endpoints } }).fetchJson });
  assert.deepEqual(r2.registration.endpoints, [{ name: 'ENS', endpoint: 'genie.eth', version: undefined }]);
  // calldata matches an independent encoder (eth_abi)
  assert.equal(encodeReadAllFeedback(42n), abi.readAllFeedbackCalldata_agent42);
});

test('A2 ipfs:// and data: tokenURIs are read correctly', async () => {
  const agents = {
    1: { owner: OWNER, uri: 'ipfs://bafkreiagentfile' },
    2: { owner: OWNER, uri: 'data:application/json;base64,' + b64({ ...REG_FILE, name: 'Base64 agent é' }) },
    3: { owner: OWNER, uri: 'data:application/json,' + encodeURIComponent(JSON.stringify({ ...REG_FILE, name: 'Plain agent' })) },
    4: { owner: OWNER, uri: 'ipfs://ipfs/bafkreiother/agent.json' },
  };
  const { rpc } = chain(agents);
  const { fetchJson, asked } = files({ 'https://ipfs.io/ipfs/bafkreiagentfile': REG_FILE, 'https://gw.example/ipfs/bafkreiother/agent.json': { ...REG_FILE, name: 'Pathed' } });
  const r1 = await loadAgent({ ...base, agentId: 1, rpc, fetchJson });
  assert.equal(r1.status, 'ok'); assert.equal(r1.registration.name, 'Genie');
  assert.equal(r1.registrationUrl, 'https://ipfs.io/ipfs/bafkreiagentfile');
  const r2 = await loadAgent({ ...base, agentId: 2, rpc, fetchJson });
  assert.equal(r2.registration.name, 'Base64 agent é');
  const r3 = await loadAgent({ ...base, agentId: 3, rpc, fetchJson });
  assert.equal(r3.registration.name, 'Plain agent');
  const r4 = await loadAgent({ ...base, agentId: 4, rpc, fetchJson, ipfsGateway: 'https://gw.example/ipfs' });
  assert.equal(r4.registration.name, 'Pathed');
  assert.deepEqual(asked, ['https://ipfs.io/ipfs/bafkreiagentfile', 'https://gw.example/ipfs/bafkreiother/agent.json'], 'data: URIs make no request');
  // the tokenURI string decodes like eth_abi encodes it
  const { rpc: rpc2 } = chain({});
  assert.equal(resolveUri('ipfs://bafkreiagentfile').url, 'https://ipfs.io/ipfs/bafkreiagentfile');
  assert.throws(() => resolveUri('ftp://x'), /unsupported/);
  void rpc2;
});

test('A3 a missing agent is a clear empty state, an RPC or file failure a clear error state, and nothing throws', async () => {
  const { fetchJson } = files({ 'https://example.com/agent.json': REG_FILE });
  // ownerOf reverts (OpenZeppelin)
  const e1 = await loadAgent({ ...base, agentId: 99, rpc: chain({}).rpc, fetchJson });
  assert.equal(e1.status, 'empty'); assert.match(e1.error, /no agent #99 on Base Sepolia/);
  // a revert reported only in the message
  const e2 = await loadAgent({ ...base, agentId: 99, rpc: chain({}, {}, { fail: new Error('call reverted') }).rpc, fetchJson });
  assert.equal(e2.status, 'empty');
  // ownerOf returns the zero address
  const e3 = await loadAgent({ ...base, agentId: 5, rpc: chain({ 5: { owner: '0x' + '0'.repeat(40), uri: '' } }).rpc, fetchJson });
  assert.equal(e3.status, 'empty'); assert.equal(e3.owner, null);
  // RPC failure
  const e4 = await loadAgent({ ...base, agentId: 1, rpc: chain({}, {}, { fail: Object.assign(new Error('rate limited'), { code: -32005 }) }).rpc, fetchJson });
  assert.equal(e4.status, 'error'); assert.match(e4.error, /rate limited \(code -32005\)/);
  // registration file failures: missing, not JSON object, bad data URI, empty URI
  for (const uri of ['https://example.com/missing.json', 'data:application/json;base64,!!!notjson', 'data:application/json,[1,2]', '', 'ar://x']) {
    const r = await loadAgent({ ...base, agentId: 1, rpc: chain({ 1: { owner: OWNER, uri } }).rpc, fetchJson });
    assert.equal(r.status, 'error', uri); assert.match(r.error, /registration file/, uri);
    assert.equal(r.owner, OWNER, 'what was read is kept');
  }
  // bad input
  for (const a of [{}, { ...base, agentId: -1 }, { ...base, agentId: 'abc' }, { ...base, agentId: 1, network: 'mainnet' }, { ...base, agentId: 1, rpc: chain({}).rpc }, { ...base, agentId: 1, identityRegistry: '0x12', rpc: chain({}).rpc, fetchJson }]) {
    const r = await loadAgent(a);
    assert.equal(r.status, 'error'); assert.equal(typeof r.error, 'string');
  }
  // garbage RPC answers
  const r = await loadAgent({ ...base, agentId: 1, rpc: async () => '0xzz', fetchJson });
  assert.equal(r.status, 'error');
  // recorded: a real missing agent on Base Sepolia
  const rec = recordedRpc('base-sepolia');
  const real = await loadAgent({ agentId: 99999999, network: 'base-sepolia', identityRegistry: ID_REG, rpc: rec, fetchJson });
  assert.equal(real.status, 'empty');
});

function recordedRpc(network) {
  return async (_m, p) => {
    const hit = recorded.calls[`${network}|${p[0].to.toLowerCase()}|${p[0].data}`];
    if (!hit) throw new Error('not recorded');
    if (hit.error) throw Object.assign(new Error(hit.error.message), { code: hit.error.code });
    return hit.result;
  };
}

test('A4 reputation entries are read and summarised, and an agent without feedback says so', async () => {
  const rows = abi.rows.map((r) => ({ ...r, value: BigInt(r.value) }));
  assert.deepEqual(decodeAllFeedback(abi.readAllFeedbackAnswer), rows, 'decodes an eth_abi encoded answer');
  assert.equal(encodeAllFeedback(rows), abi.readAllFeedbackAnswer, 'byte for byte the same as eth_abi');
  const withRevoked = [...rows, { client: rows[0].client, index: 3, value: 0n, valueDecimals: 0, tag1: 'x', tag2: '', revoked: true }];
  const agents = { 1: { owner: OWNER, uri: 'data:application/json;base64,' + b64(REG_FILE) }, 2: { owner: OWNER, uri: 'data:application/json;base64,' + b64(REG_FILE) } };
  const { rpc } = chain(agents, { 1: withRevoked });
  const r = await loadAgent({ ...base, agentId: 1, reputationRegistry: REP_REG, rpc, fetchJson: files({}).fetchJson });
  assert.equal(r.status, 'ok');
  assert.equal(r.feedback.count, 3, 'revoked feedback left out');
  assert.deepEqual(r.feedback.items.map((i) => i.score), [85, -2.5, 97.5]);
  assert.deepEqual(r.feedback.items[1].tags, ['uptime', '30d']);
  assert.deepEqual(r.feedback.items[2].tags, []);
  assert.equal(r.feedback.average, 60);
  const none = await loadAgent({ ...base, agentId: 2, reputationRegistry: REP_REG, rpc, fetchJson: files({}).fetchJson });
  assert.deepEqual(none.feedback, { count: 0, average: null, items: [] });
  assert.deepEqual(summariseFeedback([]), { count: 0, average: null, items: [] });
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /No feedback yet/);
  // a reputation registry failure is an error state, not a throw
  const bad = await loadAgent({ ...base, agentId: 1, reputationRegistry: REP_REG, rpc: chain(agents, {}, { repFail: new Error('boom') }).rpc, fetchJson: files({}).fetchJson });
  assert.equal(bad.status, 'error'); assert.match(bad.error, /reputation registry: boom/);
});

test('A5 works on Base and Base Sepolia (recorded answers from both networks)', async () => {
  assert.equal(NETWORKS.base.chainId, 8453); assert.equal(NETWORKS['base-sepolia'].chainId, 84532);
  for (const [network, name] of [['base-sepolia', 'Test Agent 004 (Image Test)'], ['base', 'ClawNews']]) {
    const r = await loadAgent({ agentId: 1, network, identityRegistry: REGISTRIES[network].identity, reputationRegistry: REGISTRIES[network].reputation, rpc: recordedRpc(network), fetchJson: async () => assert.fail('data: URI, no fetch') });
    assert.equal(r.status, 'ok', network);
    assert.equal(r.chainId, NETWORKS[network].chainId);
    assert.equal(r.registration.name, name);
    assert.match(r.owner, /^0x[0-9a-f]{40}$/);
    assert.ok(r.feedback.count > 0);
    assert.equal(typeof r.feedback.average, 'number');
  }
  // the registries default from config.js when not given
  const r = await loadAgent({ agentId: 1, network: 'base', rpc: recordedRpc('base'), fetchJson: async () => ({}) });
  assert.equal(r.status, 'ok');
  // makeRpc posts to the network RPC and keeps JSON-RPC error codes
  const seen = [];
  const rpc = makeRpc(NETWORKS.base.rpcUrl, async (url, init) => { seen.push(url); return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: 3, message: 'execution reverted' } })); });
  const e = await loadAgent({ agentId: 1, network: 'base', rpc, fetchJson: async () => ({}) });
  assert.equal(e.status, 'empty'); assert.deepEqual(seen, ['https://mainnet.base.org']);
  const fj = makeFetchJson(async () => new Response('nope', { status: 500 }));
  await assert.rejects(fj('https://example.com/a.json'), /HTTP 500/);
});

test('A5 reads the Sepolia test identity Kognai publishes on this bundle', { todo: KOGNAI_TEST_IDENTITY ? false : 'Kognai has not published the test identity yet; set it in config.js and record it at M2' }, () => {});

test('A6 mobile friendly (viewport meta, usable at 360 px), light and dark', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /from '\.\/viewer\.js'/);
  assert.match(html, /value="base-sepolia"/);
  for (const m of html.matchAll(/(?:^|[^-])width:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 360, `fixed width ${m[1]}px`);
});
