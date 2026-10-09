/* lock page config.
   Set `vault` to the deployed PulpVeVault address to switch the page from preview to live.
   Everything else (PULP and reward tokens, launch time, bonus window, minimum lock) is read from
   the vault itself once it's set. */
window.PULP_LOCK_CONFIG = {
  vault: null, // PulpVeVault address

  chain: {
    id: 4663,
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    // Multicall3 (verified on Robinhood Chain): batches page reads into one call. null = no batching.
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },

  // ETH/USD from Chainlink on Robinhood Chain, for showing fee values in dollars. null hides dollar values.
  ethUsd: {
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
    decimals: 8,
  },

  // Shown while `vault` is null, so the calculator matches the planned launch settings.
  preview: { earlyWindowHours: 24, minLock: 1000, pulpDecimals: 18 },

  refreshSeconds: 15,
};
