/* lock page: reads PulpVeVault from the chain and sends transactions through the visitor's wallet.
   No libraries. Every contract argument is a static type, so calls are ABI-encoded by hand.
   Power, the launch bonus and previews use the same integer formulas as the contract. */
(function () {
  const C = window.PULP_LOCK_CONFIG;
  const $ = (id) => document.getElementById(id);
  const WAD = 10n ** 18n;
  const DAY = 86400;
  const MAX_LOCK = 30 * DAY;
  const MIN_LOCK = 10 * DAY;
  const DURS = [10, 20, 30];
  const WORDS = { 10: "ten", 20: "twenty", 30: "thirty" };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const live = () => !!C.vault;

  /* ---------- contract interface ---------- */
  const SEL = {
    pulp: "0xe0e1a949",
    weth: "0x3fc8cef3",
    launchStart: "0xbf9f2fe7",
    earlyWindow: "0x8b3fafe2",
    minLockAmount: "0x08804275",
    getRewardTokens: "0xc4f59f9b",
    totalLocked: "0x56891412",
    locksPaused: "0xf2bb0b3a",
    locks: "0x5de9a137",
    claimable: "0xd19fb4fb",
    epochRewards: "0x02800ebd",
    totalEpochArea: "0x2b30ad2f",
    userEpochArea: "0x831f0902",
    totalNotified: "0x27d19b72",
    totalPaid: "0x3dd6d533",
    lock: "0x1338736f",
    increaseAmount: "0x15456eba",
    extend: "0x9714378c",
    withdraw: "0x3ccfd60b",
    claim: "0xaad3ec96",
    balanceOf: "0x70a08231",
    allowance: "0xdd62ed3e",
    approve: "0x095ea7b3",
    decimals: "0x313ce567",
    symbol: "0x95d89b41",
    latestAnswer: "0x50d25bcd",
  };
  const ERRORS = {
    "0x8dda39df": () => "locking opens at launch.",
    "0xa13318c5": () =>
      "new locks are paused right now. extending, withdrawing and claiming still work.",
    "0x0ba24433": () =>
      "you already have a lock. extend it or add to it instead.",
    "0xba112c93": () => "you don’t have a lock yet.",
    "0xf6fafba0": () => "your lock has ended. lock it again or withdraw.",
    "0x104a1b9e": () =>
      `your PULP unlocks ${S.lock ? fmtDate(S.lock.end) : "later"}.`,
    "0x4d84c2e9": () => "pick a length that moves your unlock date later.",
    "0xc2f5625a": () =>
      `the minimum lock is ${fmtUnits(S.minLock, S.pulpDec, 0)} PULP.`,
    "0xf4e4dfa6": () => "that’s more than the vault can take.",
    "0xe3cd89ef": () =>
      "less than 10 days left. extend your lock before adding more.",
    "0xce2d28e1": () =>
      "the token moved a different amount than asked, so the vault refused it.",
    "0x804543b5": () => "that isn’t a reward token.",
    "0x5274afe7": () => "the token transfer failed.",
    "0xe450d38c": () => "not enough PULP in this wallet.",
    "0xfb8f41b2": () => "approve PULP first.",
  };

  /* ---------- encoding ---------- */
  const strip = (h) => h.replace(/^0x/, "");
  const a32 = (a) => strip(a).toLowerCase().padStart(64, "0");
  const u32 = (n) => BigInt(n).toString(16).padStart(64, "0");
  const q = (to, data) => ({ to, data });
  const W = (h, i = 0) =>
    h && h.length >= 2 + 64 * (i + 1)
      ? BigInt("0x" + h.slice(2 + 64 * i, 2 + 64 * (i + 1)))
      : null;
  const A = (h, i = 0) =>
    h && h.length >= 2 + 64 * (i + 1)
      ? "0x" + h.slice(2 + 64 * i + 24, 2 + 64 * (i + 1))
      : null;
  function addrArray(h) {
    if (!h || h.length < 130) return [];
    const off = Number(W(h, 0)) / 32,
      n = Number(W(h, off)),
      out = [];
    for (let k = 0; k < n; k++) out.push(A(h, off + 1 + k));
    return out;
  }
  function str(h) {
    if (!h || h.length < 130) return null;
    try {
      const off = Number(W(h, 0)) / 32,
        len = Number(W(h, off));
      const hex = h.slice(2 + 64 * (off + 1), 2 + 64 * (off + 1) + len * 2);
      return new TextDecoder().decode(
        new Uint8Array((hex.match(/../g) || []).map((b) => parseInt(b, 16)))
      );
    } catch {
      return null;
    }
  }

  /* ---------- json-rpc ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpc(url, method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (res.status === 429 || res.status >= 500)
          throw new Error("the network is busy");
        const j = await res.json();
        if (j.error)
          throw Object.assign(new Error(j.error.message || "rpc error"), {
            code: j.error.code,
            data: j.error.data,
            rpc: true,
          });
        return j.result;
      } catch (e) {
        if (e.rpc || attempt >= 3) throw e; // a revert is final; only retry the transport
        await sleep(400 * 2 ** attempt);
      }
    }
  }
  const call = (to, data, from) =>
    rpc(C.chain.rpc, "eth_call", [
      from ? { from, to, data } : { to, data },
      "latest",
    ]);

  // Multicall3 aggregate3((address,bool,bytes)[]): one request for a page's worth of reads
  function encodeAggregate3(calls) {
    const parts = calls.map((c) => {
      const d = strip(c.data),
        body = d.padEnd(Math.ceil(d.length / 64) * 64, "0");
      return a32(c.to) + u32(1) + u32(0x60) + u32(d.length / 2) + body;
    });
    let off = calls.length * 32;
    const heads = parts.map((p) => {
      const h = u32(off);
      off += p.length / 2;
      return h;
    });
    return (
      "0x82ad56cb" +
      u32(0x20) +
      u32(calls.length) +
      heads.join("") +
      parts.join("")
    );
  }
  function decodeAggregate3(h) {
    const d = strip(h),
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
  async function reads(calls) {
    if (!calls.length) return [];
    if (C.chain.multicall) {
      try {
        return decodeAggregate3(
          await call(C.chain.multicall, encodeAggregate3(calls))
        );
      } catch {
        /* fall back */
      }
    }
    return Promise.all(calls.map((c) => call(c.to, c.data).catch(() => null)));
  }

  /* ---------- state ---------- */
  const S = {
    pulp: null,
    weth: null,
    pulpDec: C.preview.pulpDecimals ?? 18,
    launch: null,
    window: (C.preview.earlyWindowHours || 24) * 3600,
    minLock:
      BigInt(C.preview.minLock || 0) *
      10n ** BigInt(C.preview.pulpDecimals ?? 18),
    rewards: [],
    totalLocked: null,
    paused: false,
    totalPaid: null,
    totalNotified: null,
    queued: [],
    ethUsd: null,
    provider: null,
    account: null,
    chainOk: false,
    lock: null,
    balance: null,
    allowance: null,
    claimable: {},
    share: null,
    days: 30,
    extDays: 30,
    tab: "extend",
    busy: null,
    pressNext: false,
    loaded: false,
    offline: false,
  };
  let clockOffset = 0; // chain time minus this device's time
  const now = () => Math.floor(Date.now() / 1000) + clockOffset;

  /* ---------- the contract's formulas ---------- */
  function mult(t) {
    if (!live() || S.launch == null || t <= S.launch) return 2n * WAD;
    const el = t - S.launch;
    if (el >= S.window) return WAD;
    return WAD + (WAD * BigInt(S.window - el)) / BigInt(S.window);
  }
  const powerAt = (boosted, end, t) =>
    t >= end ? 0n : (boosted * BigInt(end - t)) / (BigInt(MAX_LOCK) * WAD);
  const previewPower = (amount, days, t) =>
    (amount * mult(t) * BigInt(days * DAY)) / (BigInt(MAX_LOCK) * WAD);

  /* ---------- formatting ---------- */
  function fmtUnits(v, dec, maxFrac = 2) {
    if (v == null) return "—";
    const base = 10n ** BigInt(dec),
      int = v / base;
    const frac = (v % base)
      .toString()
      .padStart(dec, "0")
      .slice(0, maxFrac)
      .replace(/0+$/, "");
    return int.toLocaleString("en-US") + (frac ? "." + frac : "");
  }
  function fmtAmt(v, dec, sig = 4) {
    if (v == null) return "—";
    const base = 10n ** BigInt(dec);
    if (v === 0n) return "0";
    if (v >= base * 1000n) return fmtUnits(v, dec, 0);
    if (v >= base) return fmtUnits(v, dec, 3);
    const s = v.toString().padStart(dec, "0"),
      lead = s.match(/^0*/)[0].length;
    return "0." + s.slice(0, Math.min(dec, lead + sig)).replace(/0+$/, "");
  }
  function parseAmount(text, dec) {
    const t = (text || "").replace(/[,\s_]/g, "");
    if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
    const [i, f = ""] = t.split(".");
    if (f.length > dec) return null;
    return (
      BigInt(i || "0") * 10n ** BigInt(dec) +
      BigInt((f + "0".repeat(dec)).slice(0, dec) || "0")
    );
  }
  const fmtDate = (t) =>
    new Date(t * 1000)
      .toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
      .toLowerCase()
      .replace(/,/g, "");
  const fmtDay = (t) =>
    new Date(t * 1000)
      .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      .toLowerCase();
  function fmtLeft(sec) {
    if (sec <= 0) return "now";
    const d = Math.floor(sec / DAY),
      h = Math.floor((sec % DAY) / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = sec % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }
  const fmtWindow = (sec) =>
    sec < 2 * DAY
      ? `${Math.round(sec / 3600)} hours`
      : `${Math.round(sec / DAY)} days`;
  const xFmt = (m) => (Number((m * 100n) / WAD) / 100).toFixed(2) + "×";
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const usd = (v, dec) =>
    S.ethUsd && v != null
      ? "$" +
        ((Number(v) / 10 ** dec) * S.ethUsd).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })
      : "";
  const rewardMain = () =>
    S.rewards.find((r) => r.address === S.weth) ||
    S.rewards[0] || { address: null, symbol: "WETH", decimals: 18 };
  const setText = (id, v) => {
    const el = $(id);
    if (el && el.textContent !== v) el.textContent = v;
  };

  /* ---------- chain reads ---------- */
  async function loadVault() {
    const v = C.vault;
    const r = await reads([
      q(v, SEL.pulp),
      q(v, SEL.weth),
      q(v, SEL.launchStart),
      q(v, SEL.earlyWindow),
      q(v, SEL.minLockAmount),
      q(v, SEL.getRewardTokens),
    ]);
    if (!r[0]) throw new Error("vault not found");
    S.pulp = A(r[0]);
    S.weth = A(r[1]);
    S.launch = Number(W(r[2]));
    S.window = Number(W(r[3]));
    S.minLock = W(r[4]);
    const tokens = addrArray(r[5]);
    const meta = await reads([
      q(S.pulp, SEL.decimals),
      ...tokens.flatMap((t) => [q(t, SEL.decimals), q(t, SEL.symbol)]),
    ]);
    S.pulpDec = Number(W(meta[0]) ?? 18n);
    S.rewards = tokens.map((t, k) => ({
      address: t,
      decimals: Number(W(meta[1 + 2 * k]) ?? 18n),
      symbol: str(meta[2 + 2 * k]) || "token",
    }));
  }

  async function refresh() {
    if (!live()) return renderAll();
    try {
      const blk = await rpc(C.chain.rpc, "eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      clockOffset =
        Number(BigInt(blk.timestamp)) - Math.floor(Date.now() / 1000);
      const today = Math.floor(now() / DAY),
        v = C.vault,
        acct = S.account,
        w = rewardMain().address;
      const calls = [q(v, SEL.totalLocked), q(v, SEL.locksPaused)];
      if (w) {
        calls.push(
          q(v, SEL.totalNotified + a32(w)),
          q(v, SEL.totalPaid + a32(w))
        );
        for (let i = 0; i < 7; i++)
          calls.push(q(v, SEL.epochRewards + a32(w) + u32(today + i)));
      }
      const base = calls.length;
      if (acct) {
        calls.push(
          q(v, SEL.locks + a32(acct)),
          q(S.pulp, SEL.balanceOf + a32(acct)),
          q(S.pulp, SEL.allowance + a32(acct) + a32(v))
        );
        S.rewards.forEach((t) =>
          calls.push(q(v, SEL.claimable + a32(acct) + a32(t.address) + u32(64)))
        );
        calls.push(
          q(v, SEL.userEpochArea + a32(acct) + u32(today)),
          q(v, SEL.totalEpochArea + u32(today))
        );
      }
      const r = await reads(calls);
      S.totalLocked = W(r[0]);
      S.paused = W(r[1]) === 1n;
      if (w) {
        S.totalNotified = W(r[2]);
        S.totalPaid = W(r[3]);
        S.queued = [...Array(7)].map((_, i) => W(r[4 + i]) ?? 0n);
      }
      if (acct) {
        let k = base;
        const L = r[k++];
        S.lock = L
          ? { amount: W(L, 0), boosted: W(L, 1), end: Number(W(L, 2)) }
          : null;
        S.balance = W(r[k++]);
        S.allowance = W(r[k++]);
        S.claimable = {};
        S.rewards.forEach((t) => {
          const h = r[k++];
          S.claimable[t.address] = h
            ? { amount: W(h, 0), caughtUp: W(h, 2) === 1n }
            : null;
        });
        const ua = W(r[k++]) ?? 0n,
          ta = W(r[k++]) ?? 0n;
        S.share = ta > 0n ? Number((ua * 1_000_000n) / ta) / 1e6 : null;
      }
      S.loaded = true;
      S.offline = false;
    } catch {
      S.offline = true;
    }
    renderAll();
  }

  async function loadEthUsd() {
    if (!C.ethUsd) return;
    try {
      S.ethUsd =
        Number(
          W(
            await rpc(C.ethUsd.rpc, "eth_call", [
              { to: C.ethUsd.feed, data: SEL.latestAnswer },
              "latest",
            ])
          )
        ) /
        10 ** C.ethUsd.decimals;
      renderAll();
    } catch {
      /* dollar values just stay hidden */
    }
  }

  /* ---------- wallet (EIP-6963, with a plain injected wallet as fallback) ---------- */
  const wallets = new Map();
  const SAVED = "paperdao-wallet";
  addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (!d || !d.info || !d.provider) return;
    wallets.set(d.info.uuid, d);
    reconnect(d);
  });
  dispatchEvent(new Event("eip6963:requestProvider"));

  async function reconnect(d) {
    if (!live()) return; // before the vault is deployed the page never talks to a wallet
    let saved = null;
    try {
      saved = localStorage.getItem(SAVED);
    } catch {
      /* private window */
    }
    if (S.account || !saved || saved !== d.info.rdns) return;
    try {
      const a = await d.provider.request({ method: "eth_accounts" });
      if (a && a[0]) attach(d.provider, a[0], d.info.rdns);
    } catch {
      /* stays disconnected */
    }
  }
  function connect() {
    if (!live()) return;
    const list = [...wallets.values()];
    if (!list.length && window.ethereum)
      return choose({
        provider: window.ethereum,
        info: { name: "browser wallet", rdns: "injected" },
      });
    if (!list.length)
      return toast(
        "no wallet found. install one, such as rabby or metamask, and reload this page.",
        "error"
      );
    if (list.length === 1) return choose(list[0]);
    const ul = $("wallets");
    ul.innerHTML = "";
    list.forEach((d) => {
      const li = document.createElement("li"),
        b = document.createElement("button");
      b.type = "button";
      if (d.info.icon) {
        const img = document.createElement("img");
        img.src = d.info.icon;
        img.alt = "";
        b.append(img);
      }
      b.append(document.createTextNode(d.info.name || "wallet"));
      b.addEventListener("click", () => {
        $("picker").close();
        choose(d);
      });
      li.append(b);
      ul.append(li);
    });
    $("picker").showModal();
  }
  async function choose(d) {
    try {
      const a = await d.provider.request({ method: "eth_requestAccounts" });
      if (a && a[0]) attach(d.provider, a[0], d.info.rdns);
    } catch (e) {
      toast(friendly(e).message, "error");
    }
  }
  function attach(p, account, rdns) {
    S.provider = p;
    S.account = account;
    try {
      localStorage.setItem(SAVED, rdns || "");
    } catch {
      /* fine */
    }
    if (p.on && !p.__paperdao) {
      p.__paperdao = true;
      p.on("accountsChanged", (a) => {
        S.account = a && a[0] ? a[0] : null;
        if (!S.account) S.provider = null;
        clearUser();
        refresh();
      });
      p.on("chainChanged", () => checkChain().then(refresh));
    }
    checkChain().then(refresh);
  }
  function disconnect() {
    S.provider = null;
    S.account = null;
    clearUser();
    try {
      localStorage.removeItem(SAVED);
    } catch {
      /* fine */
    }
    toast("wallet disconnected from this page.", "ok");
    renderAll();
  }
  function clearUser() {
    S.lock = null;
    S.balance = null;
    S.allowance = null;
    S.claimable = {};
    S.share = null;
  }
  async function checkChain() {
    if (!S.provider) return;
    try {
      S.chainOk =
        parseInt(await S.provider.request({ method: "eth_chainId" }), 16) ===
        C.chain.id;
    } catch {
      S.chainOk = false;
    }
    renderAll();
  }
  async function switchChain() {
    const hex = "0x" + C.chain.id.toString(16);
    try {
      await S.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      });
    } catch (e) {
      if (
        e &&
        (e.code === 4902 ||
          /unrecognized|not added|unknown chain/i.test(e.message || ""))
      ) {
        await S.provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hex,
              chainName: C.chain.name,
              rpcUrls: [C.chain.rpc],
              blockExplorerUrls: [C.chain.explorer],
              nativeCurrency: C.chain.currency,
            },
          ],
        });
      } else throw e;
    }
    await checkChain();
  }

  /* ---------- transactions ---------- */
  function friendly(e) {
    if (e && e.friendly) return e;
    const f = (s) => Object.assign(new Error(s), { friendly: true });
    if (
      e &&
      (e.code === 4001 ||
        /user (rejected|denied)|rejected the request|request rejected/i.test(
          e.message || ""
        ))
    )
      return f("you cancelled in your wallet.");
    const data =
      typeof e?.data === "string"
        ? e.data
        : e?.data?.data || e?.error?.data || e?.data?.originalError?.data;
    if (typeof data === "string" && data.length >= 10) {
      const sel = data.slice(0, 10);
      if (ERRORS[sel]) return f(ERRORS[sel]());
      if (sel === "0x08c379a0") {
        const s = str("0x" + data.slice(10));
        if (s) return f(s);
      }
    }
    return f(
      (e && (e.shortMessage || e.message)) || "something went wrong. try again."
    );
  }
  async function receipt(hash) {
    for (let i = 0; i < 240; i++) {
      try {
        const r = await rpc(C.chain.rpc, "eth_getTransactionReceipt", [hash]);
        if (r) return r;
      } catch {
        /* keep waiting */
      }
      await sleep(750);
    }
    return null;
  }
  async function send(to, data, labels) {
    S.busy = labels.busy;
    renderAll();
    try {
      try {
        await call(to, data, S.account);
      } catch (e) {
        throw friendly(e);
      } // dry run first: a clear reason instead of a failed transaction
      const hash = await S.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: S.account, to, data }],
      });
      toast(`${labels.busy}…`, "pending", hash);
      const r = await receipt(hash);
      if (!r || r.status !== "0x1")
        throw friendly(
          new Error("the transaction didn’t go through. nothing was moved.")
        );
      toast(labels.done, "ok", hash);
      return true;
    } catch (e) {
      toast(friendly(e).message, "error");
      return false;
    } finally {
      S.busy = null;
      await refresh();
    }
  }

  /* ---------- what the main buttons say and do ---------- */
  function gate() {
    if (!live())
      return {
        label: "live in phase II",
        disabled: true,
        note: "locking goes live in phase II. this is a preview of what a lock gets you.",
      };
    if (S.launch && now() < S.launch)
      return {
        label: `opens in ${fmtLeft(S.launch - now())}`,
        disabled: true,
        note: `locking opens ${fmtDate(S.launch)}.`,
      };
    if (!S.account) return { label: "connect wallet", action: connect };
    if (!S.chainOk)
      return {
        label: `switch to ${C.chain.name}`,
        action: () =>
          switchChain().catch((e) => toast(friendly(e).message, "error")),
      };
    if (S.busy) return { label: S.busy, disabled: true, busy: true };
    return null;
  }
  function approveOr(amt, next) {
    if (S.allowance == null || S.allowance < amt) {
      return {
        label: `approve ${fmtUnits(amt, S.pulpDec, 2)} PULP`,
        action: () =>
          send(S.pulp, SEL.approve + a32(C.vault) + u32(amt), {
            busy: "approving",
            done: "approved. now confirm the lock.",
          }),
      };
    }
    return next;
  }
  function newState() {
    const g = gate();
    if (g) return g;
    const amt = parseAmount($("amount").value, S.pulpDec);
    if (S.paused)
      return {
        label: "new locks are paused",
        disabled: true,
        note: "extending, withdrawing and claiming still work.",
      };
    if (amt == null || amt === 0n)
      return { label: "enter an amount", disabled: true };
    if (S.minLock != null && amt < S.minLock)
      return {
        label: `minimum ${fmtUnits(S.minLock, S.pulpDec, 0)} PULP`,
        disabled: true,
      };
    if (S.balance != null && amt > S.balance)
      return {
        label: "not enough PULP",
        disabled: true,
        note: `this wallet has ${fmtUnits(S.balance, S.pulpDec, 2)} PULP.`,
      };
    return approveOr(amt, {
      label: `lock for ${S.days} days`,
      note: `you can’t withdraw before ${fmtDate(now() + S.days * DAY)}.`,
      action: async () => {
        if (
          await send(C.vault, SEL.lock + u32(amt) + u32(S.days), {
            busy: "locking",
            done: "locked. here’s your certificate.",
          })
        )
          S.pressNext = true;
        renderAll();
      },
    });
  }
  function manageState() {
    const L = S.lock,
      t = now(),
      ended = t >= L.end;
    const g = gate();
    if (g && !g.label.startsWith("opens")) return g;
    if (ended && S.tab === "withdraw") {
      return {
        label: `withdraw ${fmtUnits(L.amount, S.pulpDec, 2)} PULP`,
        action: () =>
          send(C.vault, SEL.withdraw, {
            busy: "withdrawing",
            done: "withdrawn. your rewards stay claimable.",
          }),
      };
    }
    if (S.tab === "add") {
      if (S.paused) return { label: "top-ups are paused", disabled: true };
      if (L.end - t < MIN_LOCK)
        return {
          label: "extend first",
          disabled: true,
          note: "less than 10 days left. extend your lock before adding more.",
        };
      const amt = parseAmount($("add-amount").value, S.pulpDec);
      if (amt == null || amt === 0n)
        return { label: "enter an amount", disabled: true };
      if (S.balance != null && amt > S.balance)
        return { label: "not enough PULP", disabled: true };
      return approveOr(amt, {
        label: `add ${fmtUnits(amt, S.pulpDec, 2)} PULP`,
        action: () =>
          send(C.vault, SEL.increaseAmount + u32(amt), {
            busy: "adding",
            done: "added to your lock.",
          }),
      });
    }
    // extend (or, once ended, lock again)
    const d = S.extDays,
      newEnd = t + d * DAY;
    if (!ended && newEnd <= L.end)
      return {
        label: "pick a longer length",
        disabled: true,
        note: "an extension has to move your unlock date later.",
      };
    return {
      label: ended ? `lock again for ${d} days` : `extend to ${d} days`,
      note: ended
        ? "locking again uses today’s launch bonus."
        : "your launch bonus carries over.",
      action: () =>
        send(C.vault, SEL.extend + u32(d), {
          busy: ended ? "locking again" : "extending",
          done: ended ? "locked again." : "extended. your power is back up.",
        }),
    };
  }
  function paintButton(btn, note, st) {
    const sig = `${st.label}|${!!st.disabled}|${!!st.busy}`;
    if (btn._sig !== sig) {
      btn._sig = sig;
      btn.disabled = !!st.disabled;
      btn.replaceChildren();
      if (st.busy) {
        const sp = document.createElement("span");
        sp.className = "spin";
        sp.setAttribute("aria-hidden", "true");
        btn.append(sp);
      }
      btn.append(document.createTextNode(st.label));
    }
    btn._action = st.action || null;
    if (note.textContent !== (st.note || "")) note.textContent = st.note || "";
  }

  /* ---------- rendering ---------- */
  function hasLock() {
    return !!(S.lock && S.lock.amount > 0n);
  }

  function renderWallet() {
    const b = $("wallet");
    b.disabled = !live();
    if (!live()) {
      b.textContent = "live in phase II";
      b.title = "locking goes live in phase II";
      return;
    }
    b.classList.toggle("warn", !!S.account && !S.chainOk);
    if (!S.account) {
      b.textContent = "connect wallet";
      b.title = "";
      return;
    }
    if (!S.chainOk) {
      b.textContent = "wrong network";
      b.title = `switch to ${C.chain.name}`;
      return;
    }
    b.innerHTML =
      '<span class="dot" aria-hidden="true"></span>' + short(S.account);
    b.title = "disconnect";
  }

  function renderBonus() {
    const t = now(),
      m = mult(t);
    let fill = 100,
      note;
    if (!live())
      note = `2× at launch, falling to 1× over the first ${fmtWindow(
        S.window
      )}.`;
    else if (t < S.launch)
      note = `locking opens ${fmtDate(
        S.launch
      )}. the bonus starts at 2× and falls to 1× over ${fmtWindow(S.window)}.`;
    else if (t < S.launch + S.window) {
      fill = ((S.launch + S.window - t) / S.window) * 100;
      note = `falls to 1× in ${fmtLeft(
        S.launch + S.window - t
      )}. lock sooner to keep more of it.`;
    } else {
      fill = 0;
      note =
        "the launch bonus has ended. early lockers keep theirs for as long as they extend.";
    }
    setText("bonus-x", xFmt(m));
    $("bonus-fill").style.width = fill.toFixed(2) + "%";
    setText("bonus-note", note);
  }

  function renderNew() {
    const t = now(),
      amt = parseAmount($("amount").value, S.pulpDec) ?? 0n,
      soon = !live();
    // until the vault is deployed the form is a fixed preview: nothing can be typed, picked or sent
    $("new-form").classList.toggle("soon", soon);
    $("amount").disabled = soon;
    $("max").disabled = soon;
    document.querySelectorAll("#durs .dur").forEach((b) => {
      const d = +b.dataset.days;
      b.disabled = soon;
      b.setAttribute("aria-pressed", String(d === S.days));
      b.querySelector("span").textContent = `power ${fmtUnits(
        previewPower(amt, d, t),
        S.pulpDec,
        0
      )}`;
    });
    setText("s-unlock", fmtDate(t + S.days * DAY));
    setText("s-bonus", xFmt(mult(t)));
    setText("s-power", fmtUnits(previewPower(amt, S.days, t), S.pulpDec, 0));
    setText(
      "bal",
      S.balance != null ? `${fmtUnits(S.balance, S.pulpDec, 2)} PULP` : "—"
    );
    paintButton($("act"), $("act-note"), newState());
  }

  function renderManage() {
    const L = S.lock,
      t = now(),
      ended = t >= L.end;
    if (ended && !S.wasEnded) S.tab = "withdraw"; // a lock that just ended opens on withdraw
    S.wasEnded = ended;
    if (ended && !["withdraw", "extend"].includes(S.tab)) S.tab = "withdraw";
    if (!ended && !["extend", "add"].includes(S.tab)) S.tab = "extend";
    setText("m-title", ended ? "your lock has ended" : "your lock");
    setText(
      "m-sub",
      ended
        ? `your ${fmtUnits(L.amount, S.pulpDec, 2)} PULP unlocked ${fmtDate(
            L.end
          )}. withdraw it, or lock it again to keep earning.`
        : `${fmtUnits(L.amount, S.pulpDec, 2)} PULP, unlocks ${fmtDate(
            L.end
          )}. extending resets your power.`
    );
    const tabA = $("tab-extend"),
      tabB = $("tab-add");
    tabA.textContent = ended ? "withdraw" : "extend";
    tabB.textContent = ended ? "lock again" : "add PULP";
    const active = ended
      ? S.tab === "withdraw"
        ? tabA
        : tabB
      : S.tab === "extend"
      ? tabA
      : tabB;
    [tabA, tabB].forEach((b) =>
      b.setAttribute("aria-selected", String(b === active))
    );
    const showDurs = ended ? S.tab === "extend" : S.tab === "extend";
    $("m-extend").hidden = !showDurs;
    $("m-add").hidden = ended || S.tab !== "add";

    setText("ext-legend", ended ? "lock again for" : "reset your lock to");
    document.querySelectorAll("#ext-durs .dur").forEach((b) => {
      const d = +b.dataset.days,
        newEnd = t + d * DAY,
        ok = ended || newEnd > L.end;
      b.disabled = !ok;
      b.setAttribute("aria-pressed", String(d === S.extDays));
      const boosted = ended ? L.amount * mult(t) : L.boosted;
      b.querySelector("span").textContent = ok
        ? `power ${fmtUnits(powerAt(boosted, newEnd, t), S.pulpDec, 0)}`
        : "too short";
    });
    const boostedAfter = ended ? L.amount * mult(t) : L.boosted;
    setText("e-unlock", fmtDate(t + S.extDays * DAY));
    setText(
      "e-power",
      fmtUnits(powerAt(boostedAfter, t + S.extDays * DAY, t), S.pulpDec, 0)
    );
    const add = parseAmount($("add-amount").value, S.pulpDec) ?? 0n;
    setText(
      "add-bal",
      S.balance != null ? `${fmtUnits(S.balance, S.pulpDec, 2)} PULP` : "—"
    );
    setText(
      "a-power",
      fmtUnits(powerAt(add * mult(t), L.end, t), S.pulpDec, 0)
    );
    paintButton($("m-act"), $("m-note"), manageState());
  }

  function renderCert() {
    const t = now(),
      cert = $("cert"),
      stamp = $("stamp");
    if (hasLock()) {
      const L = S.lock,
        ended = t >= L.end,
        p = powerAt(L.boosted, L.end, t),
        full = L.boosted / WAD;
      cert.classList.remove("preview");
      setText(
        "c-no",
        "№ " +
          String(parseInt(S.account.slice(2, 8), 16) % 100000).padStart(5, "0")
      );
      setText("c-amount", fmtUnits(L.amount, S.pulpDec, 2));
      setText(
        "c-words",
        ended ? "unlocked, ready to withdraw" : `locked until ${fmtDate(L.end)}`
      );
      setText("c-bonus", xFmt(L.boosted / L.amount || WAD));
      setText("c-power-label", "power now");
      setText("c-power", fmtUnits(p, S.pulpDec, 0));
      setText("c-unlock-label", ended ? "unlocked" : "unlocks in");
      setText("c-unlock", ended ? fmtDay(L.end) : fmtLeft(L.end - t));
      const pct = full > 0n ? Number((p * 10000n) / full) / 100 : 0;
      $("c-meter").style.width = pct + "%";
      setText(
        "c-meter-label",
        ended ? "no power left" : `${pct.toFixed(0)}% of full power`
      );
      setText("c-holder", `issued to ${short(S.account)}`);
      stamp.toggleAttribute("hidden", false); // an <svg> has no .hidden property
      stamp.classList.toggle("ok", ended);
      setText("stamp-word", ended ? "unlocked" : "locked");
      setText("stamp-date", ended ? fmtDay(L.end) : `until ${fmtDay(L.end)}`);
      if (S.pressNext && !reduce) {
        S.pressNext = false;
        stamp.classList.remove("pressing");
        void stamp.getBoundingClientRect();
        stamp.classList.add("pressing");
      }
    } else {
      const amt = parseAmount($("amount").value, S.pulpDec) ?? 0n;
      cert.classList.add("preview");
      setText("c-no", "preview");
      setText("c-amount", fmtUnits(amt, S.pulpDec, 2));
      setText("c-words", `locked for ${WORDS[S.days]} days`);
      setText("c-bonus", xFmt(mult(t)));
      setText("c-power-label", "starting power");
      setText("c-power", fmtUnits(previewPower(amt, S.days, t), S.pulpDec, 0));
      setText("c-unlock-label", "unlocks");
      setText("c-unlock", fmtDay(t + S.days * DAY));
      $("c-meter").style.width = (S.days / 30) * 100 + "%";
      setText(
        "c-meter-label",
        S.days === 30
          ? "full power"
          : `${Math.round((S.days / 30) * 100)}% of full power`
      );
      setText(
        "c-holder",
        S.account ? `issued to ${short(S.account)}` : "issued to you"
      );
      stamp.toggleAttribute("hidden", true);
    }
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function el(name, attrs, text) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  const num = (v) => Number(v) / 10 ** S.pulpDec;
  const compact = (n) =>
    n >= 1e6
      ? (n / 1e6).toFixed(2) + "m"
      : n >= 1e4
      ? (n / 1e3).toFixed(1) + "k"
      : Math.round(n).toLocaleString("en-US");

  function renderCurve() {
    const svg = $("curve"),
      t = now(),
      Wd = 640,
      H = 230,
      L = 52,
      R = 16,
      T = 18,
      B = 32;
    const lines = [];
    let top, legend;
    if (hasLock()) {
      const Lk = S.lock,
        active = t < Lk.end;
      const boosted = active ? Lk.boosted : Lk.amount * mult(t); // what a fresh 10/20/30 days would start from
      const left = active ? (Lk.end - t) / DAY : 0;
      DURS.forEach((d) => {
        if (active && d === 30 && left > 29.6) return; // a brand-new 30-day lock is the same line as yours
        lines.push({
          a: [0, num(powerAt(boosted, t + d * DAY, t))],
          b: [d, 0],
          main: false,
          tag: `${d} days`,
        });
      });
      if (active)
        lines.push({
          a: [0, num(powerAt(Lk.boosted, Lk.end, t))],
          b: [left, 0],
          main: true,
          tag: "your lock",
          mid: true,
        });
      top = num(powerAt(boosted, t + 30 * DAY, t));
      legend = ["your lock", "a fresh 10, 20 or 30-day lock"];
      setText(
        "curve-note",
        active
          ? "your power shrinks every day until it unlocks. extending puts it back up."
          : "your lock has ended. locking again starts a new line."
      );
    } else {
      const amt = parseAmount($("amount").value, S.pulpDec) ?? 0n;
      DURS.forEach((d) =>
        lines.push({
          a: [0, num(previewPower(amt, d, t))],
          b: [d, 0],
          main: d === S.days,
          tag: `${d} days`,
        })
      );
      lines.sort((x, y) => x.main - y.main);
      top = num(previewPower(amt, 30, t));
      legend = ["your choice", "the other lengths"];
      setText(
        "curve-note",
        "a longer lock starts higher and stays higher for longer. power shrinks as the unlock date gets closer."
      );
    }
    const lg = $("curve-legend").children;
    if (lg[0].lastChild.textContent !== legend[0])
      lg[0].lastChild.textContent = legend[0];
    if (lg[1].lastChild.textContent !== legend[1])
      lg[1].lastChild.textContent = legend[1];
    if (!(top > 0)) top = 1;
    const X = (d) => L + (d / 30) * (Wd - L - R),
      Y = (p) => T + (1 - p / (top * 1.06)) * (H - T - B);
    svg.replaceChildren();
    const defs = el("defs", {}),
      grad = el("linearGradient", {
        id: "curve-fill",
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 1,
      });
    grad.append(
      el("stop", {
        offset: 0,
        style: "stop-color:var(--oxblood);stop-opacity:.22",
      }),
      el("stop", {
        offset: 1,
        style: "stop-color:var(--oxblood);stop-opacity:0",
      })
    );
    defs.append(grad);
    svg.append(defs);
    [0, 0.5, 1].forEach((f) => {
      const y = Y(top * f);
      svg.append(
        el("line", { x1: L, x2: Wd - R, y1: y, y2: y, class: "grid" }),
        el(
          "text",
          { x: L - 10, y: y + 4, "text-anchor": "end", class: "ax" },
          compact(top * f)
        )
      );
    });
    [0, 10, 20, 30].forEach((d) =>
      svg.append(
        el(
          "text",
          {
            x: X(d),
            y: H - 10,
            "text-anchor": d === 0 ? "start" : d === 30 ? "end" : "middle",
            class: "ax",
          },
          d === 0 ? "today" : `day ${d}`
        )
      )
    );
    lines.forEach((ln) => {
      const [x1, y1, x2, y2] = [X(ln.a[0]), Y(ln.a[1]), X(ln.b[0]), Y(ln.b[1])];
      if (ln.main)
        svg.append(
          el("path", {
            d: `M${x1},${y1} L${x2},${y2} L${x2},${Y(0)} L${x1},${Y(0)} Z`,
            fill: "url(#curve-fill)",
          })
        );
      const col = ln.main ? "var(--oxblood)" : "var(--ink-3)";
      svg.append(
        el("line", {
          x1,
          y1,
          x2,
          y2,
          style: `stroke:${col};stroke-width:${
            ln.main ? 2.6 : 1.4
          };stroke-linecap:round${ln.main ? "" : ";stroke-dasharray:5 5"}`,
        })
      );
      svg.append(
        el("circle", {
          cx: x1,
          cy: y1,
          r: ln.main ? 4.5 : 3,
          style: `fill:${col}`,
        })
      );
      const [lx, ly] = ln.mid
        ? [x1 + (x2 - x1) * 0.45 + 8, y1 + (y2 - y1) * 0.45 - 10]
        : [x1 + 10, y1 - 8];
      svg.append(
        el("text", { x: lx, y: ly, class: "lbl", style: `fill:${col}` }, ln.tag)
      );
    });
  }

  function renderStats() {
    const t = now(),
      rw = rewardMain(),
      queued = S.queued.reduce((a, b) => a + b, 0n);
    const put = (id, v, on) => {
      setText(id, v);
      $(id).classList.toggle("none", !on);
    };
    put(
      "st-locked",
      S.totalLocked != null ? fmtUnits(S.totalLocked, S.pulpDec, 0) : "—",
      S.totalLocked != null
    );
    put("st-bonus", xFmt(mult(t)), true);
    put(
      "st-queued",
      S.loaded ? `${fmtAmt(queued, rw.decimals)} ${rw.symbol}` : "—",
      S.loaded && queued > 0n
    );
    put(
      "st-paid",
      S.totalPaid != null
        ? `${fmtAmt(S.totalPaid, rw.decimals)} ${rw.symbol}`
        : "—",
      S.totalPaid != null && S.totalPaid > 0n
    );
  }

  function renderFees() {
    const svg = $("fees"),
      Wd = 640,
      H = 220,
      L = 14,
      R = 14,
      T = 26,
      B = 34,
      rw = rewardMain();
    const today = Math.floor(now() / DAY);
    const vals = S.queued.length ? S.queued : Array(7).fill(0n);
    const nums = vals.map((v) => Number(v) / 10 ** rw.decimals);
    const max = Math.max(...nums),
      ghost = !(max > 0);
    svg.replaceChildren();
    const bw = (Wd - L - R) / 7;
    nums.forEach((n, i) => {
      const h = ghost
        ? (H - T - B) * (0.16 + 0.34 * Math.abs(Math.sin(i * 1.3 + 0.6)))
        : Math.max(2, (n / max) * (H - T - B));
      const x = L + i * bw + bw * 0.16,
        w = bw * 0.68,
        y = H - B - h;
      svg.append(
        el("rect", {
          x,
          y,
          width: w,
          height: h,
          rx: 6,
          style: `fill:${
            ghost
              ? "var(--rule-2)"
              : i === 0
              ? "var(--bar)"
              : "color-mix(in srgb, var(--bar) 50%, transparent)"
          }`,
        })
      );
      if (!ghost && n > 0)
        svg.append(
          el(
            "text",
            {
              x: x + w / 2,
              y: y - 8,
              "text-anchor": "middle",
              class: "lbl",
              style: "fill:var(--ink)",
            },
            fmtAmt(vals[i], rw.decimals, 3)
          )
        );
      const day = new Date((today + i) * DAY * 1000)
        .toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })
        .toLowerCase();
      svg.append(
        el(
          "text",
          { x: x + w / 2, y: H - 10, "text-anchor": "middle", class: "ax" },
          i === 0 ? "today" : day
        )
      );
    });
    if (ghost)
      svg.append(
        el(
          "text",
          { x: Wd / 2, y: T + 22, "text-anchor": "middle", class: "ax" },
          live()
            ? "no rewards queued right now"
            : "rewards appear here in phase II"
        )
      );
    setText(
      "fees-note",
      `in ${rw.symbol}. each top-up is shared over the next 7 days, which run midnight to midnight utc.`
    );
  }

  let mineSig = "";
  function renderMine() {
    const rw = rewardMain(),
      rows = [],
      buttons = [];
    let note;
    if (!live()) {
      rows.push(["claimable now", "—"], ["your share of today’s rewards", "—"]);
      note = "rewards start in phase II.";
    } else if (!S.account) {
      rows.push(["claimable now", "—"], ["your share of today’s rewards", "—"]);
      note = "connect your wallet to see your rewards.";
      buttons.push({ label: "connect wallet", kind: "connect" });
    } else {
      note = "a day’s rewards can be claimed once it ends (midnight utc).";
      S.rewards.forEach((tok) => {
        const c = S.claimable[tok.address];
        rows.push([
          `claimable now, ${tok.symbol}`,
          c ? `${fmtAmt(c.amount, tok.decimals)} ${tok.symbol}` : "—",
          c && tok.address === rw.address && c.amount > 0n
            ? usd(c.amount, tok.decimals)
            : "",
        ]);
        if (c && c.amount > 0n)
          buttons.push({
            label: S.busy
              ? S.busy
              : `claim ${fmtAmt(c.amount, tok.decimals)} ${tok.symbol}`,
            kind: "claim",
            token: tok.address,
            disabled: !!S.busy,
          });
      });
      rows.push([
        "your share of today’s rewards",
        S.share != null
          ? (S.share * 100).toFixed(S.share < 0.01 ? 3 : 2) + "%"
          : "0%",
      ]);
      if (!buttons.length)
        buttons.push({ label: "nothing to claim yet", disabled: true });
    }
    setText("mine-note", note);
    const sig = JSON.stringify([rows, buttons]);
    if (sig === mineSig) return;
    mineSig = sig;
    const ul = $("mine-rows"),
      box = $("claims");
    ul.replaceChildren();
    box.replaceChildren();
    rows.forEach(([label, value, sub]) => {
      const li = document.createElement("li"),
        sp = document.createElement("span"),
        b = document.createElement("b");
      sp.textContent = label;
      b.textContent = value;
      if (sub) {
        const sm = document.createElement("small");
        sm.textContent = sub;
        b.append(sm);
      }
      li.append(sp, b);
      ul.append(li);
    });
    buttons.forEach((spec) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn " + (spec.disabled ? "btn-line" : "btn-ox");
      b.textContent = spec.label;
      b.disabled = !!spec.disabled;
      if (spec.kind === "connect") b.addEventListener("click", connect);
      if (spec.kind === "claim")
        b.addEventListener("click", () => claimToken(spec.token));
      box.append(b);
    });
  }
  function claimToken(token) {
    const tok = S.rewards.find((t) => t.address === token),
      c = S.claimable[token];
    if (!tok || !c) return;
    if (!S.chainOk)
      return switchChain().catch((e) => toast(friendly(e).message, "error"));
    send(C.vault, SEL.claim + a32(token) + u32(64), {
      busy: "claiming",
      done: c.caughtUp
        ? `claimed ${tok.symbol}.`
        : `claimed a batch of ${tok.symbol}. claim again for the rest.`,
    });
  }

  function renderAll() {
    $("phase").hidden = live(); // the phase II note goes once the vault is set
    renderWallet();
    renderBonus();
    const showManage = live() && hasLock();
    $("new-form").hidden = showManage;
    $("manage").hidden = !showManage;
    if (showManage) renderManage();
    else renderNew();
    renderCert();
    renderCurve();
    renderStats();
    renderFees();
    renderMine();
    if (S.offline)
      toast("can’t reach the chain right now. retrying…", "error", null, true);
  }

  /* ---------- status toast ---------- */
  let toastTimer = 0;
  function toast(msg, kind, hash, quiet) {
    const t = $("toast");
    if (quiet && !t.hidden) return;
    setText("toast-msg", msg);
    t.className = "toast" + (kind === "error" ? " error" : "");
    const a = $("toast-link");
    if (hash) {
      a.href = `${C.chain.explorer}/tx/${hash}`;
      a.hidden = false;
    } else a.hidden = true;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (kind !== "pending")
      toastTimer = setTimeout(
        () => {
          t.hidden = true;
        },
        kind === "error" ? 9000 : 6000
      );
  }

  /* ---------- events ---------- */
  function wire() {
    $("wallet").addEventListener("click", () => {
      if (!S.account) return connect();
      if (!S.chainOk)
        return switchChain().catch((e) => toast(friendly(e).message, "error"));
      disconnect();
    });
    $("new-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("act")._action;
      if (a) a();
    });
    $("m-act").addEventListener("click", () => {
      const a = $("m-act")._action;
      if (a) a();
    });
    $("amount").addEventListener("input", renderAll);
    $("add-amount").addEventListener("input", renderAll);
    const tidy = (input) =>
      input.addEventListener("blur", () => {
        const v = parseAmount(input.value, S.pulpDec);
        if (v != null) input.value = fmtUnits(v, S.pulpDec, 6);
      });
    tidy($("amount"));
    tidy($("add-amount"));
    $("max").addEventListener("click", () => {
      if (S.balance != null) {
        $("amount").value = fmtUnits(S.balance, S.pulpDec, S.pulpDec);
        renderAll();
      }
    });
    $("add-max").addEventListener("click", () => {
      if (S.balance != null) {
        $("add-amount").value = fmtUnits(S.balance, S.pulpDec, S.pulpDec);
        renderAll();
      }
    });
    $("durs").addEventListener("click", (e) => {
      const b = e.target.closest(".dur");
      if (b && !b.disabled) {
        S.days = +b.dataset.days;
        renderAll();
      }
    });
    $("ext-durs").addEventListener("click", (e) => {
      const b = e.target.closest(".dur");
      if (b && !b.disabled) {
        S.extDays = +b.dataset.days;
        renderAll();
      }
    });
    $("tab-extend").addEventListener("click", () => {
      S.tab = hasLock() && now() >= S.lock.end ? "withdraw" : "extend";
      renderAll();
    });
    $("tab-add").addEventListener("click", () => {
      S.tab = hasLock() && now() >= S.lock.end ? "extend" : "add";
      renderAll();
    });
    $("toast-x").addEventListener("click", () => {
      $("toast").hidden = true;
    });
  }

  async function init() {
    wire();
    renderAll();
    loadEthUsd();
    setInterval(loadEthUsd, 60_000);
    if (live()) {
      try {
        await loadVault();
      } catch {
        S.offline = true;
      }
      await refresh();
      setInterval(refresh, (C.refreshSeconds || 15) * 1000);
    }
    // the countdowns, the bonus gauge and your live power move every second
    setInterval(() => {
      renderBonus();
      renderCert();
      renderStats();
      if (live() && hasLock()) renderManage();
    }, 1000);
  }
  init();
})();
