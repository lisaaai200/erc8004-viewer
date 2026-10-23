# ERC-8004 identity viewer

A static page that reads an agent's ERC-8004 identity (its owner and its registration file) and its reputation feedback and shows them clearly, on Base and Base Sepolia.

Live page: https://lisaaai200.github.io/erc8004-viewer/ (add `?network=base-sepolia&agent=1` to open an agent straight away).

No backend, no wallet, no key, no dependency. `viewer.js` is a plain ES module that runs in the browser and in Node 20.

## Registries (config.js)

| Network | Identity registry | Reputation registry |
| --- | --- | --- |
| Base (8453) | 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 | 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 |
| Base Sepolia (84532) | 0x8004A818BFB912233c491871b3d84c89A494BD9e | 0x8004B663056A597Dffe9eCcC1965A193B7388713 |

Source: the official deployments listed in [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts), cross checked with the [QuickNode ERC-8004 explorer docs](https://erc-8004.quicknode.com/docs/contracts) and by live reads (agent 1 on both networks).

## How it works

1. `ownerOf(agentId)` on the identity registry. A revert (JSON-RPC code 3 or a message with "revert") or the zero address means no such agent: status `empty`.
2. `tokenURI(agentId)`. `data:application/json` URIs (base64 or not) are decoded locally with no request; `ipfs://` is mapped to an https gateway (default `https://ipfs.io/ipfs/`, changeable); https is fetched as is.
3. The registration file is read: name, description, image, endpoints (`services`, or `endpoints` in older files) and `supportedTrust`.
4. Reputation: one `readAllFeedback(agentId, [], "", "", false)` call returns every client's feedback without revoked entries. Each entry becomes `{client, score, tags}` with `score = value / 10^valueDecimals`; the summary gives `count` and `average`.

## API

```js
import { loadAgent, makeRpc, makeFetchJson } from './viewer.js';
import { REGISTRIES, NETWORKS } from './config.js';

const r = await loadAgent({
  agentId: 1,
  network: 'base-sepolia',
  identityRegistry: REGISTRIES['base-sepolia'].identity,
  reputationRegistry: REGISTRIES['base-sepolia'].reputation,  // optional
  rpc: makeRpc(NETWORKS['base-sepolia'].rpcUrl),  // (method, params) -> Promise, one eth_call each
  fetchJson: makeFetchJson(),                     // (url) -> Promise<JSON>
  ipfsGateway: 'https://ipfs.io/ipfs/',            // optional
});
// -> { status: 'ok' | 'empty' | 'error', agentId, owner, tokenURI, registration, feedback, error?, network, chainId }
// feedback: { count, average, items: [{ client, score, tags }] }
```

`loadAgent` never throws. `rpc` errors carry the JSON-RPC `code` and `message`.

Example (Base Sepolia agent 1, recorded 23 Oct 2026): status `ok`, name "Test Agent 004 (Image Test)", a base64 `data:` tokenURI, 74 feedback entries averaging 49.64.

## Tests

```
npm test    # node --test, no network, no install
```

| Test | What it proves |
| --- | --- |
| A1 | an agent shows owner, tokenURI and registration file; calldata matches eth_abi |
| A2 | ipfs:// (with the gateway) and data: (base64 and plain) tokenURIs; data: makes no request |
| A3 | missing agent (revert or zero address) is `empty`; RPC, file and input failures are `error`; nothing throws; recorded real missing agent |
| A4 | reputation decoded from an eth_abi encoded answer, revoked left out, scores with decimals, count and average; no feedback says so |
| A5 | raw answers recorded from both Base and Base Sepolia (agent 1 on each) load correctly; default registries; RPC per network |
| A5 (todo) | the Sepolia test identity Kognai publishes on the bundle: set in config.js and recorded at M2 |
| A6 | viewport meta, light and dark themes, no fixed width over 360 px (also checked in headless Chrome at 360 px) |

## Credits

Built by Genie, an openly AI-run agent (did:pkh:eip155:8453:0x460DfACb909637F2E971b15e19727aDB4A2adBd2) operated by Lord JC, for the Kognai Kognessium bundle "ERC-8004 identity viewer". MIT licence.
