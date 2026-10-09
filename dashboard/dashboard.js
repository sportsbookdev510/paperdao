/* paperdao dashboard: reads the treasury straight from Robinhood Chain and HyperEVM (ETH/USD from Base).
   No positions, markets or trades are read or shown. Config lives in config.js. */
(function () {
  const C = window.PAPERDAO_CONFIG;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const preview = location.hash === "#preview";
  const sample = !C.live; // sample numbers until the dashboard is opened
  if (!C.live && !preview) {
    document.body.classList.add("gated");
    document.querySelector(".dash").inert = true;
  }

  /* ---------- formatting ---------- */
  const fin = (n) => n != null && isFinite(n);
  const usd = (n) => {
    if (!fin(n)) return "$—";
    const a = Math.abs(n),
      s = n < 0 ? "-$" : "$";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "b";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "m";
    if (a >= 1e4) return s + (a / 1e3).toFixed(1) + "k";
    if (a >= 1)
      return (
        s +
        a.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      );
    if (a === 0) return "$0";
    return s + a.toPrecision(3);
  };
  const compact = (n) =>
    !fin(n)
      ? "—"
      : n >= 1e9
      ? (n / 1e9).toFixed(2) + "b"
      : n >= 1e6
      ? (n / 1e6).toFixed(2) + "m"
      : n >= 1e3
      ? (n / 1e3).toFixed(1) + "k"
      : n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const pct = (n, d = 1) =>
    !fin(n) ? "—%" : (n > 0 ? "+" : "") + (n * 100).toFixed(d) + "%";
  const share = (n) =>
    !fin(n)
      ? "—%"
      : n >= 0.01
      ? (n * 100).toFixed(2) + "%"
      : (n * 100).toPrecision(2) + "%";

  /* ---------- json-rpc ---------- */
  const SEL = {
    balanceOf: "0x70a08231",
    totalSupply: "0x18160ddd",
    getSlot0: "0xc815641c",
    getLiquidity: "0xfa6793d5",
    latestAnswer: "0x50d25bcd",
  };
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const word = (h) => (h && h.length >= 66 ? BigInt(h.slice(0, 66)) : null);
  const units = (b, d) => (b == null ? null : Number(b) / 10 ** d);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // POST with retries: public RPCs rate-limit (429), so back off and try again
  async function post(url, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.status === 429 || r.status >= 500)
          throw new Error(url + " " + r.status);
        return await r.json();
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(500 * 2 ** attempt + Math.random() * 300);
      }
    }
  }
  // JSON-RPC batch, 8 per request (base caps batches at 10), one request at a time; a failed call comes back as null
  async function batch(url, reqs) {
    const out = new Array(reqs.length).fill(null);
    for (let start = 0; start < reqs.length; start += 8) {
      const body = reqs
        .slice(start, start + 8)
        .map((q, i) => ({
          jsonrpc: "2.0",
          id: start + i,
          method: q[0],
          params: q[1],
        }));
      let res;
      try {
        res = await post(url, body);
      } catch (e) {
        res = null;
      }
      if (!Array.isArray(res)) {
        res = [];
        for (const b of body)
          res.push(await post(url, b).catch(() => ({ id: b.id, error: 1 })));
      }
      res.forEach((x) => {
        if (x && !x.error) out[x.id] = x.result;
      });
    }
    return out;
  }

  // Multicall3 (same address on Robinhood Chain and HyperEVM): many reads in one eth_call
  const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const nativeOf = (a) => ({ to: MULTICALL, data: "0x4d2301cc" + pad(a) }); // getEthBalance(address)
  const u256 = (n) => n.toString(16).padStart(64, "0");
  function encodeAggregate3(calls) {
    // aggregate3((address,bool,bytes)[])
    const parts = calls.map((c) => {
      const d = c.data.replace(/^0x/, ""),
        body = d.padEnd(Math.ceil(d.length / 64) * 64, "0");
      return pad(c.to) + u256(1) + u256(0x60) + u256(d.length / 2) + body;
    });
    let off = calls.length * 32;
    const heads = parts.map((x) => {
      const h = u256(off);
      off += x.length / 2;
      return h;
    });
    return (
      "0x82ad56cb" +
      u256(0x20) +
      u256(calls.length) +
      heads.join("") +
      parts.join("")
    );
  }
  function decodeAggregate3(h) {
    // (bool success, bytes data)[]
    const d = h.slice(2),
      w = (i) => parseInt(d.slice(i, i + 64), 16);
    const a = w(0) * 2,
      n = w(a),
      base = a + 64,
      out = [];
    for (let i = 0; i < n; i++) {
      const e = base + w(base + i * 64) * 2,
        ok = w(e) === 1,
        b = e + w(e + 64) * 2,
        len = w(b);
      out.push(ok && len ? "0x" + d.slice(b + 64, b + 64 + len * 2) : null);
    }
    return out;
  }
  async function multi(url, calls, tag = "latest") {
    if (!calls.length) return [];
    const [h] = await batch(url, [
      ["eth_call", [{ to: MULTICALL, data: encodeAggregate3(calls) }, tag]],
    ]);
    return h ? decodeAggregate3(h) : calls.map(() => null);
  }
  const q = (to, data) => ({ to, data });

  /* ---------- live reads ---------- */
  const assetGroup = (t) => (t.price === "usd" ? "stablecoins" : "eth");

  async function readLive() {
    const ch = C.chains,
      items = [],
      connected = {};
    const [ans] = await multi(C.ethUsd.rpc, [
      q(C.ethUsd.feed, SEL.latestAnswer),
    ]);
    const ethUsd = units(word(ans), C.ethUsd.decimals);

    // papertrade reads (HyperEVM) ride along with the HyperEVM treasury multicall
    const pt = C.papertrade,
      tre = ch.hyperevm.treasury,
      ptCalls = [],
      at = {};
    Object.entries(pt.reads).forEach(([k, r]) => {
      if (!r || !r.to) return;
      if (r.data.includes("{treasury}") && !tre) return;
      at[k] = ptCalls.length;
      ptCalls.push(q(r.to, r.data.replace("{treasury}", tre ? pad(tre) : "")));
    });
    if (pt.paper) {
      if (tre) {
        at.paperHeld = ptCalls.length;
        ptCalls.push(q(pt.paper, SEL.balanceOf + pad(tre)));
      }
      at.paperSupply = ptCalls.length;
      ptCalls.push(q(pt.paper, SEL.totalSupply));
    }
    let pres = [];

    await Promise.all(
      Object.entries(ch).map(async ([key, c]) => {
        connected[key] = !!c.treasury;
        const calls = [];
        if (c.treasury) {
          if (c.native) calls.push(nativeOf(c.treasury));
          c.tokens.forEach((t) =>
            calls.push(q(t.address, SEL.balanceOf + pad(c.treasury)))
          );
        }
        const own = calls.length;
        if (key === "hyperevm") calls.push(...ptCalls);
        if (!calls.length) return;
        const res = await multi(c.rpc, calls);
        if (key === "hyperevm") pres = res.slice(own);
        if (!c.treasury) return;
        let i = 0;
        if (c.native) {
          const v = units(word(res[i++]), 18);
          items.push({
            chain: key,
            group: "eth",
            label: "ETH",
            usd: fin(v) ? v * ethUsd : null,
          });
        }
        c.tokens.forEach((t) => {
          const v = units(word(res[i++]), t.decimals);
          items.push({
            chain: key,
            group: assetGroup(t),
            label: t.symbol,
            usd: fin(v) ? v * (t.price === "eth" ? ethUsd : 1) : null,
          });
        });
      })
    );

    const read = (k, d) => (at[k] == null ? null : units(word(pres[at[k]]), d));
    const margin = read("marginUsd", pt.reads.marginUsd?.decimals);
    const queue = read("payoutQueueUsd", pt.reads.payoutQueueUsd?.decimals);
    const rewards = read(
      "stakingUsdcEarned",
      pt.reads.stakingUsdcEarned?.decimals
    );
    if (fin(margin))
      items.push({
        chain: "hyperevm",
        group: "margin",
        label: "papertrade margin",
        usd: margin,
      });
    if (fin(queue))
      items.push({
        chain: "hyperevm",
        group: "queue",
        label: "payout queue",
        usd: queue,
      });
    if (fin(rewards))
      items.push({
        chain: "hyperevm",
        group: "rewards",
        label: "staking rewards",
        usd: rewards,
      });
    const paperHeld = read("paperHeld", pt.paperDecimals),
      paperStaked = read("stakedPaper", pt.reads.stakedPaper?.decimals);
    const paper = {
      total:
        fin(paperHeld) || fin(paperStaked)
          ? (paperHeld || 0) + (paperStaked || 0)
          : null,
      staked: paperStaked,
      supply: read("paperSupply", pt.paperDecimals),
    };
    const trackedLp = read("trackedLpUsd", pt.reads.trackedLpUsd?.decimals);

    // $pulp
    const pc = ch[C.pulp.chain],
      d = C.pulp.decimals,
      pulp = { price: null, supply: null, dead: 0, poolUsd: null };
    if (C.pulp.token) {
      const calls = [
        q(C.pulp.token, SEL.totalSupply),
        q(C.pulp.token, SEL.balanceOf + pad(DEAD)),
      ];
      if (hasPool())
        calls.push(
          q(C.pulp.stateView, SEL.getSlot0 + pad(C.pulp.poolId)),
          q(C.pulp.stateView, SEL.getLiquidity + pad(C.pulp.poolId))
        );
      const r = await multi(pc.rpc, calls);
      pulp.supply = units(word(r[0]), d);
      pulp.dead = units(word(r[1]), d) || 0;
      const sqrtP = hasPool() ? sqrtPrice(r[2]) : null;
      if (sqrtP) {
        pulp.price = pulpPrice(sqrtP) * ethUsd;
        // v4 pools have no balance of their own (everything sits in the PoolManager), so this is the
        // liquidity active at today's price: the ETH side of it, doubled, since both sides are equal in value
        const L = Number(word(r[3]) ?? 0n),
          ethSide = (pulpIsCurrency0() ? L * sqrtP : L / sqrtP) / 1e18;
        if (fin(ethSide) && fin(ethUsd)) pulp.poolUsd = 2 * ethSide * ethUsd;
      }
    }
    return { ethUsd, items, connected, paper, trackedLp, pulp, at: Date.now() };
  }

  /* ---------- the uniswap v4 pool ---------- */
  const hasPool = () => !!(C.pulp.poolId && C.pulp.stateView);
  // v4 sorts a pool's two currencies by address; native ETH is address 0, so it always comes first
  const pulpIsCurrency0 = () =>
    BigInt(C.pulp.token) < BigInt(C.pulp.pairedWith || "0x0");
  // sqrtPriceX96 is the low 160 bits of getSlot0's first word; returned as a plain sqrt(price)
  function sqrtPrice(slot0Hex) {
    const w = word(slot0Hex);
    if (w == null) return null;
    const s = Number(w & ((1n << 160n) - 1n)) / 2 ** 96;
    return s > 0 ? s : null; // 0 means the pool isn't initialized
  }
  // price of 1 $pulp in ETH. the pool's other side is ETH or WETH (18 decimals)
  function pulpPrice(sqrtP) {
    const raw = sqrtP ** 2,
      dp = C.pulp.decimals; // raw currency1 per raw currency0
    return pulpIsCurrency0()
      ? raw * 10 ** (dp - 18)
      : 1 / (raw * 10 ** (18 - dp));
  }

  // $pulp price history: samples the pool at past blocks (needs a chain that serves old state)
  async function readHistory(hours) {
    const pc = C.chains[C.pulp.chain];
    if (!C.pulp.token || !hasPool() || !pc.history) return null;
    const [headHex] = await batch(pc.rpc, [["eth_blockNumber", []]]);
    const head = parseInt(headHex, 16),
      N = 24,
      span = (hours * 3600) / pc.blockTime;
    const sameChain = C.ethUsd.rpc === pc.rpc,
      reqs = [],
      blocks = [];
    const calls = [
      q(C.pulp.stateView, SEL.getSlot0 + pad(C.pulp.poolId)),
    ].concat(sameChain ? [q(C.ethUsd.feed, SEL.latestAnswer)] : []);
    const data = encodeAggregate3(calls);
    for (let i = 0; i < N; i++) {
      const b = Math.round(head - span * (1 - i / (N - 1)));
      blocks.push(b);
      reqs.push(["eth_call", [{ to: MULTICALL, data }, "0x" + b.toString(16)]]);
    }
    const res = await batch(pc.rpc, reqs),
      now = Date.now(),
      pts = [];
    blocks.forEach((b, i) => {
      if (!res[i]) return; // before the pool existed, or not served
      const [s0, a] = decodeAggregate3(res[i]);
      const sqrtP = sqrtPrice(s0);
      if (!sqrtP) return;
      const eth = sameChain ? units(word(a), C.ethUsd.decimals) : state.ethUsd;
      pts.push({
        t: now - (head - b) * pc.blockTime * 1000,
        v: pulpPrice(sqrtP) * eth,
      });
    });
    return pts.length > 1 ? pts : null;
  }

  /* ---------- sample data (until the dashboard is opened) ---------- */
  function rng(seed) {
    return () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  }
  function sampleState() {
    const items = [
      { chain: "robinhood", group: "eth", label: "ETH", usd: 182400 },
      { chain: "robinhood", group: "stablecoins", label: "USDG", usd: 41250 },
      { chain: "hyperevm", group: "stablecoins", label: "USDC", usd: 158900 },
      {
        chain: "hyperevm",
        group: "margin",
        label: "papertrade margin",
        usd: 736200,
      },
      { chain: "hyperevm", group: "queue", label: "payout queue", usd: 38600 },
      {
        chain: "hyperevm",
        group: "rewards",
        label: "staking rewards",
        usd: 27350,
      },
    ];
    return {
      ethUsd: 2690,
      items,
      connected: { robinhood: true, hyperevm: true },
      paper: { total: 41_260_000, staked: 41_260_000, supply: 382_000_000 },
      trackedLp: 1_460_000,
      pulp: { price: 0.001214, supply: 992_400_000, dead: 0, poolUsd: 214_000 },
      at: Date.now(),
    };
  }
  function sampleHistory(hours, nav) {
    const r = rng(hours * 7 + 3),
      N = 36,
      now = Date.now(),
      pts = [];
    let v = nav * (hours > 100 ? 0.82 : 0.97);
    for (let i = 0; i < N; i++) {
      v *= 1 + (r() - 0.46) * (hours > 100 ? 0.06 : 0.025);
      pts.push({ t: now - (1 - i / (N - 1)) * hours * 3600e3, v });
    }
    const k = state.pulp.price / pts[N - 1].v; // end the walk on today's price
    pts.forEach((p) => (p.v *= k));
    return pts;
  }

  /* ---------- derived numbers ---------- */
  let state = null,
    range = 168,
    view = "chain",
    history;
  function derive(s) {
    const tvl = s.items.reduce((m, x) => m + (fin(x.usd) ? x.usd : 0), 0);
    const p = s.pulp,
      initial = C.pulp.initialSupply;
    const circ = fin(p.supply) ? p.supply - (p.dead || 0) : null;
    const burned = fin(p.supply) ? initial - p.supply + (p.dead || 0) : null;
    const nav = fin(circ) && circ > 0 && tvl > 0 ? tvl / circ : null;
    return {
      tvl: tvl > 0 ? tvl : null,
      nav,
      circ,
      burned,
      mcap: fin(p.price) && fin(circ) ? p.price * circ : null,
      prem: fin(p.price) && fin(nav) ? p.price / nav - 1 : null,
      paperPer1m:
        fin(s.paper.total) && fin(circ) ? (s.paper.total / circ) * 1e6 : null,
      paperShare:
        fin(s.paper.total) && fin(s.paper.supply) && s.paper.supply > 0
          ? s.paper.total / s.paper.supply
          : null,
    };
  }

  /* ---------- render ---------- */
  const GROUPS = {
    chain: Object.fromEntries(
      Object.entries(C.chains).map(([k, c], i) => [
        k,
        [c.name, ["--c1", "--c3", "--c2", "--c4"][i % 4]],
      ])
    ),
    asset: {
      margin: ["papertrade margin", "--c1"],
      stablecoins: ["stablecoins", "--c4"],
      eth: ["ETH", "--c2"],
      queue: ["payout queue", "--c3"],
      rewards: ["staking rewards", "--c5"],
    },
  };

  function render() {
    const s = state,
      d = derive(s);
    $("k-tvl").textContent = usd(d.tvl);
    $("k-nav").textContent = usd(d.nav);
    $("k-price").textContent = usd(s.pulp.price);
    $("k-prem").textContent = pct(d.prem);
    const pc = $("k-prem-chip");
    pc.textContent = !fin(d.prem)
      ? "no price yet"
      : d.prem >= 0
      ? "above nav"
      : "below nav";
    pc.className = "chip " + (!fin(d.prem) ? "" : d.prem >= 0 ? "up" : "down");
    $("k-mcap").textContent = usd(d.mcap);
    $("k-circ").textContent = compact(d.circ);
    $("k-burned").textContent = compact(d.burned);
    $("k-pool").textContent = usd(s.pulp.poolUsd);

    // paper
    $("p-total").textContent = compact(s.paper.total);
    $("p-per").textContent = compact(d.paperPer1m);
    $("p-share").textContent = share(d.paperShare);
    const lp = s.trackedLp,
      max = 6e6;
    $("lp-fill").style.width = fin(lp)
      ? Math.min(100, (lp / max) * 100) + "%"
      : "0%";
    $("lp-val").textContent = fin(lp)
      ? usd(lp) + " tracked lp"
      : "tracked lp not connected";
    $("lp-note").textContent = !fin(lp)
      ? ""
      : lp < 2e6
      ? "flat mint region: 100 paper per $1 of loss basis"
      : lp < 5e6
      ? "past $2m: the mint curve is decaying"
      : "past $5m: excess lp revenue sweeps to stakers";

    // supply
    const initial = C.pulp.initialSupply;
    $("s-burn-fill").style.width = fin(d.burned)
      ? Math.max(0.4, (d.burned / initial) * 100) + "%"
      : "0%";
    $("s-initial").textContent = compact(initial);
    $("s-burned").textContent = fin(d.burned)
      ? compact(d.burned) + " (" + share(d.burned / initial) + ")"
      : "—";
    $("s-circ").textContent = compact(d.circ);

    document
      .querySelectorAll(".kpi .v, .mini b, .big3 b, .kv b, .mine-out b")
      .forEach((el) => el.classList.toggle("none", /—/.test(el.textContent)));
    renderMix();
    renderMine();
    renderStatus();
    drawChart();
  }

  function renderMix() {
    const s = state,
      map = GROUPS[view],
      sums = {};
    Object.keys(map).forEach((k) => (sums[k] = 0));
    s.items.forEach((x) => {
      const k = view === "chain" ? x.chain : x.group;
      if (fin(x.usd) && k in sums) sums[k] += x.usd;
    });
    const total = Object.values(sums).reduce((a, b) => a + b, 0);
    const keys = Object.keys(map).sort((a, b) => sums[b] - sums[a]);
    $("mix-bar").innerHTML =
      keys
        .filter((k) => sums[k] > 0)
        .map(
          (k) =>
            `<span data-k="${k}" style="flex:${sums[k]};background:var(${map[k][1]})" title="${map[k][0]}"></span>`
        )
        .join("") || '<span class="empty"></span>';
    $("mix-rows").innerHTML = keys
      .map((k) => {
        const off = view === "chain" && !s.connected[k];
        return (
          `<li data-k="${k}" class="${
            off ? "off" : ""
          }"><span class="lab"><i class="dot" style="background:var(${
            map[k][1]
          })"></i>${map[k][0]}</span>` +
          `<span class="val">${
            off ? "not connected" : usd(sums[k])
          }</span><span class="pc">${
            off || !total ? "" : share(sums[k] / total)
          }</span></li>`
        );
      })
      .join("");
  }

  function renderMine() {
    const d = derive(state),
      amt = mineAmount;
    $("m-market").textContent = fin(state.pulp.price)
      ? usd(amt * state.pulp.price)
      : "$—";
    $("m-nav").textContent = fin(d.nav) ? usd(amt * d.nav) : "$—";
    $("m-share").textContent = fin(d.circ) ? share(amt / d.circ) : "—%";
    $("m-paper").textContent =
      fin(d.circ) && fin(state.paper.total)
        ? compact((amt / d.circ) * state.paper.total) + " paper"
        : "— paper";
    document
      .querySelectorAll(".mine-out b")
      .forEach((el) => el.classList.toggle("none", /—/.test(el.textContent)));
  }

  function renderStatus() {
    const names = Object.entries(C.chains).map(([k, c]) =>
      c.name.toLowerCase()
    );
    const ago = Math.round((Date.now() - state.at) / 1000);
    const anything =
      C.pulp.token || Object.values(C.chains).some((c) => c.treasury);
    $("status").innerHTML = sample
      ? '<i class="live off"></i>sample data. the dashboard reads the chains once it opens.'
      : !anything
      ? '<i class="live off"></i>waiting on the raise. numbers fill in as $pulp and the treasury go live.'
      : `<i class="live"></i>read from ${names.join(", ")} · updated ${
          ago < 5 ? "just now" : ago + "s ago"
        }`;
    if (C.showAddresses && !sample) {
      $("addrs").innerHTML = Object.values(C.chains)
        .filter((c) => c.treasury)
        .map(
          (c) =>
            `<a href="${c.explorer}/address/${
              c.treasury
            }" target="_blank" rel="noopener">treasury on ${c.name.toLowerCase()}</a>`
        )
        .join("");
    }
  }

  /* ---------- chart: $pulp price against nav per $pulp ---------- */
  // placeholder shape shown faded while there's no real history
  function ghostSeries(hours) {
    const N = 48,
      now = Date.now(),
      out = [];
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      out.push({
        t: now - (1 - x) * hours * 3600e3,
        v: 1 + 0.35 * x + 0.12 * Math.sin(x * 9) + 0.05 * Math.sin(x * 23 + 1),
      });
    }
    return out;
  }
  const svg = $("chart"),
    tip = $("tip");
  let geom = null;
  function drawChart() {
    const d = derive(state),
      nav = d.nav;
    const box = svg.parentElement.getBoundingClientRect(),
      W = Math.max(300, box.width),
      H = 280;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const L = 64,
      R = 16,
      T = 18,
      B = 34;
    const ghost = !history || history.length < 2;
    const pts = ghost ? ghostSeries(range) : history;
    svg.classList.toggle("ghost", ghost);
    const vals = pts.map((p) => p.v).concat(!ghost && fin(nav) ? [nav] : []);
    let lo = Math.min(...vals),
      hi = Math.max(...vals);
    const padv = (hi - lo || hi * 0.1) * 0.12;
    lo = Math.max(0, lo - padv);
    hi += padv;
    const t0 = pts[0].t,
      t1 = pts[pts.length - 1].t;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R),
      Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let g = "";
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4,
        y = Y(v);
      g += `<line x1="${L}" x2="${
        W - R
      }" y1="${y}" y2="${y}" class="grid"/><text x="${L - 10}" y="${
        y + 4
      }" text-anchor="end" class="ax">${ghost ? "$—" : usd(v)}</text>`;
    }
    for (let i = 0; i <= 3; i++) {
      const t = t0 + ((t1 - t0) * i) / 3,
        x = X(t),
        dt = new Date(t);
      const lab =
        range <= 24
          ? dt.toLocaleTimeString("en-US", { hour: "numeric" }).toLowerCase()
          : dt
              .toLocaleDateString("en-US", { month: "short", day: "numeric" })
              .toLowerCase();
      g += `<text x="${x}" y="${H - 10}" text-anchor="${
        i === 0 ? "start" : i === 3 ? "end" : "middle"
      }" class="ax">${lab}</text>`;
    }
    const line = pts
      .map(
        (p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1)
      )
      .join("");
    const area = line + `L${X(t1).toFixed(1)},${H - B}L${L},${H - B}Z`;
    let navG = "";
    if (!ghost && fin(nav)) {
      const y = Y(nav);
      navG = `<line x1="${L}" x2="${
        W - R
      }" y1="${y}" y2="${y}" class="navline"/><text x="${W - R}" y="${
        y - 7
      }" text-anchor="end" class="navlab">nav per $pulp ${usd(nav)}</text>`;
    }
    const last = pts[pts.length - 1];
    svg.innerHTML =
      `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c1)" stop-opacity=".22"/><stop offset="1" stop-color="var(--c1)" stop-opacity="0"/></linearGradient></defs>` +
      g +
      `<path d="${area}" fill="url(#fade)"/>` +
      navG +
      `<path d="${line}" class="pline"/>` +
      `<circle cx="${X(last.t)}" cy="${Y(last.v)}" r="4.5" class="pdot"/>` +
      `<g id="hover" style="display:none"><line id="hx" y1="${T}" y2="${
        H - B
      }" class="hx"/><circle id="hd" r="5" class="pdot"/></g>` +
      `<rect x="${L}" y="${T}" width="${W - L - R}" height="${
        H - T - B
      }" fill="transparent" id="hit"/>`;
    geom = ghost ? null : { X, Y, W, nav };
  }
  svg.addEventListener("pointermove", (e) => {
    if (!geom || !history) return;
    const b = svg.getBoundingClientRect(),
      x = (e.clientX - b.left) * (geom.W / b.width);
    let best = history[0],
      bd = Infinity;
    history.forEach((p) => {
      const dd = Math.abs(geom.X(p.t) - x);
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    });
    const hx = geom.X(best.t),
      hy = geom.Y(best.v),
      h = $("hover");
    if (!h) return;
    h.style.display = "";
    $("hx").setAttribute("x1", hx);
    $("hx").setAttribute("x2", hx);
    $("hd").setAttribute("cx", hx);
    $("hd").setAttribute("cy", hy);
    const dt = new Date(best.t);
    tip.innerHTML =
      `<b>${usd(best.v)}</b><span>${dt
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()}, ${dt
        .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        .toLowerCase()}</span>` +
      (fin(geom.nav)
        ? `<span>${pct(best.v / geom.nav - 1)} vs nav now</span>`
        : "");
    tip.hidden = false;
    const px = (hx / geom.W) * b.width;
    tip.style.left = Math.min(Math.max(px, 70), b.width - 70) + "px";
    tip.style.top = (hy / 280) * b.height + "px";
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    const h = $("hover");
    if (h) h.style.display = "none";
  });

  /* ---------- controls ---------- */
  document.querySelectorAll("[data-range]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      range = +btn.dataset.range;
      document
        .querySelectorAll("[data-range]")
        .forEach((b) => b.setAttribute("aria-pressed", b === btn));
      history = undefined;
      drawChart();
      await loadHistory();
      drawChart();
    })
  );
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => {
      view = btn.dataset.view;
      document
        .querySelectorAll("[data-view]")
        .forEach((b) => b.setAttribute("aria-pressed", b === btn));
      renderMix();
    })
  );
  // hovering a legend row highlights its slice
  $("mix-rows").addEventListener("pointerover", (e) => {
    const li = e.target.closest("li");
    if (li) $("mix-bar").dataset.hl = li.dataset.k;
  });
  $("mix-rows").addEventListener("pointerleave", () => {
    delete $("mix-bar").dataset.hl;
  });
  $("mix-bar").addEventListener("pointerover", (e) => {
    const sp = e.target.closest("span[data-k]");
    if (sp) $("mix-bar").dataset.hl = sp.dataset.k;
  });
  $("mix-bar").addEventListener("pointerleave", () => {
    delete $("mix-bar").dataset.hl;
  });
  new MutationObserver(() => {
    const k = $("mix-bar").dataset.hl;
    $("mix-bar")
      .querySelectorAll("span")
      .forEach((s) => s.classList.toggle("dim", !!k && s.dataset.k !== k));
    $("mix-rows")
      .querySelectorAll("li")
      .forEach((li) => li.classList.toggle("dim", !!k && li.dataset.k !== k));
  }).observe($("mix-bar"), { attributes: true, attributeFilter: ["data-hl"] });

  // your $pulp: an amount, or a wallet address to look up
  let mineAmount = 1_000_000,
    mineTimer = 0;
  $("mine").addEventListener("input", () => {
    const v = $("mine").value.trim();
    clearTimeout(mineTimer);
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
      if (sample || !C.pulp.token) {
        $("mine-note").textContent = "address lookup works once $pulp is live.";
        return;
      }
      $("mine-note").textContent = "looking up…";
      mineTimer = setTimeout(async () => {
        const pc = C.chains[C.pulp.chain];
        const [h] = await multi(pc.rpc, [
          q(C.pulp.token, SEL.balanceOf + pad(v)),
        ]);
        const bal = units(word(h), C.pulp.decimals);
        if (fin(bal)) {
          mineAmount = bal;
          $("mine-note").textContent = `${compact(
            bal
          )} $pulp in that wallet on ${pc.name.toLowerCase()}.`;
        } else
          $("mine-note").textContent =
            "couldn’t read that wallet. check the address and try again.";
        renderMine();
      }, 350);
      return;
    }
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    mineAmount = fin(n) ? n : 0;
    $("mine-note").textContent = "or paste a wallet address to look it up.";
    renderMine();
  });

  /* ---------- load loop ---------- */
  async function loadHistory() {
    if (sample) {
      history = sampleHistory(range, derive(state).nav);
      return;
    }
    try {
      history = await readHistory(range);
    } catch (e) {
      history = null;
    }
  }
  async function load() {
    if (sample) state = sampleState();
    else {
      try {
        state = await readLive();
      } catch (e) {
        if (!state) {
          $("status").innerHTML =
            '<i class="live off"></i>couldn’t reach the chains. retrying shortly.';
          return;
        }
      }
    }
    render();
  }
  addEventListener("resize", () => {
    clearTimeout(drawChart.t);
    drawChart.t = setTimeout(drawChart, 120);
  });

  (async () => {
    await load();
    if (!state) return;
    await loadHistory();
    drawChart();
    if (!sample) setInterval(load, C.refreshSeconds * 1000);
    setInterval(() => state && renderStatus(), 5000);
  })();
})();
