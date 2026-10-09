/* paperdao dashboard config.
   Everything the dashboard shows is read straight from the chains below, in the visitor's browser.
   Fill in addresses as they exist, then set `live: true` to open the dashboard.
   Anything left as null shows as "not connected" instead of a number. */
window.PAPERDAO_CONFIG = {
  // false = the dashboard is shown blurred behind an "opens at launch" panel, with sample data.
  // add #preview to the URL to see the sample layout unblurred.
  live: true,
  launchDate: "2026-10-08",

  // $pulp, the daos.world token
  pulp: {
    chain: "robinhood", // key from `chains` below, wherever the daos.world token lives
    token: null, // $pulp ERC-20 address
    // the Uniswap v4 pool. v4 keeps every pool inside one PoolManager, so a pool is an id, read
    // through Uniswap's StateView contract on the same chain
    poolId: null, // bytes32 pool id (0x + 64 hex), from the pool's page or its Initialize event
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", // Uniswap v4 StateView on Robinhood Chain (from Uniswap's deployments list)
    pairedWith: null, // the pool's other side: null for native ETH, or the WETH address
    decimals: 18,
    initialSupply: 1_000_000_000,
  },

  // ETH/USD price: Chainlink's ETH/USD feed on Robinhood Chain (verified onchain).
  ethUsd: {
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
    decimals: 8,
  },

  // where the treasury holds funds, in display order. `treasury` is the wallet or fund contract
  // on that chain. native: what the chain's gas token is worth ('eth' or null to skip it).
  // history: true only if `rpc` serves old state (an archive node); it powers the price chart.
  chains: {
    robinhood: {
      name: "Robinhood Chain",
      chainId: 4663,
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://robinhoodchain.blockscout.com",
      blockTime: 0.1,
      history: false,
      treasury: null,
      native: "eth",
      tokens: [
        {
          symbol: "WETH",
          address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
          decimals: 18,
          price: "eth",
        },
        {
          symbol: "USDG",
          address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
          decimals: 6,
          price: "usd",
        },
      ],
    },
    hyperevm: {
      name: "HyperEVM",
      chainId: 999,
      rpc: "https://rpc.hyperliquid.xyz/evm",
      explorer: "https://hyperevmscan.io",
      blockTime: 1,
      history: false,
      treasury: null,
      native: null,
      tokens: [
        {
          symbol: "USDC",
          address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
          decimals: 6,
          price: "usd",
        },
      ],
    },
  },

  // papertrade on HyperEVM. fill these once papertrade publishes its contracts.
  // each read is an eth_call that returns one uint256. `{treasury}` in `data` is replaced
  // with the HyperEVM treasury address, padded to 32 bytes.
  papertrade: {
    paper: null, // PAPER token address (balance held + total supply)
    paperDecimals: 18,
    reads: {
      marginUsd: null, // e.g. { to: '0x…', data: '0x<selector>{treasury}', decimals: 6 }
      payoutQueueUsd: null, // winnings waiting in the FIFO queue
      stakedPaper: null, // paper staked by the treasury
      stakingUsdcEarned: null, // usdc earned from staking, unclaimed
      trackedLpUsd: null, // papertrade's tracked lp size (no {treasury} needed)
    },
  },

  // link treasury addresses to block explorers. off by default: anyone can read a public address.
  showAddresses: false,

  refreshSeconds: 30,
};
