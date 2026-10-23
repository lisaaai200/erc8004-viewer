// ERC-8004 deployments targeted by the viewer.
// Source: the official erc-8004/erc-8004-contracts README (https://github.com/erc-8004/erc-8004-contracts),
// cross checked with https://erc-8004.quicknode.com/docs/contracts. CREATE2 addresses, same on every
// mainnet and on every testnet.
export const REGISTRIES = {
  base: {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  'base-sepolia': {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
};

export const NETWORKS = {
  base: { chainId: 8453, name: 'Base', rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  'base-sepolia': { chainId: 84532, name: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
};

export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** The Sepolia test identity Kognai publishes on the bundle. null until it is published. */
export const KOGNAI_TEST_IDENTITY = null;
