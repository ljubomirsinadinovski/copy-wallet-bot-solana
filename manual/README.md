# Manual trading (runs on your Mac)

Buy and sell tokens by hand from your own wallets. A separate small server – it reuses the bot's code
(keystore, pump.fun/Jupiter trading, position accounting, recovery) from `../server/src` and the app's UI
parts from `../web/src`, but never watches or copies anyone, and sends no Telegram messages. The folder is
in git but never deployed (the Docker image leaves it out); `manual/manual.env` stays out of git.

## Use

```bash
bash manual/run.sh
```

Open http://127.0.0.1:8790. Stop with **Ctrl+C** when you're done – trades in progress finish first.

1. **First run:** choose a passphrase for the manual data folder (`data-manual`), then **Generate** a wallet
   (or **Import** one) and send it SOL. Its address is under **Wallets**.
2. **Buy:** pick the wallet, paste the token's contract address (the token's market cap, route and any
   safety warnings appear), enter dollars, confirm.
3. **Sell:** on a position, **Sell…** → the % of what's in the wallet, and a **min leftover ($)**: if what
   would be left is worth less than that, everything is sold. The tokens are counted on-chain right before
   the sell.
4. **Sell plan:** on a position, **Plan…** → sell it by market-cap levels, slowly, into other people's
   buys (see below).

## Sell plans

A plan sells a position step by step: each **level** is a market cap and a % of what the wallet held when
the plan started (e.g. 10% at $100k, 15% at $200k, …). What no level covers is the **moon bag** and is
never sold. Sell plans work for pump.fun coins (on the curve or on PumpSwap) priced in SOL or USDC.

- **Into buys only.** While a level's market cap is reached, every check compares the pool's SOL with the
  last check. A share of what others bought (net, default 30%) may be sold; others' sells take that share
  back. If the price drops below the level, the level waits.
- **Small sells.** Each sell moves the price at most the set % (default 1.5%) and uses a tight slippage
  (default 2%) so bots can't sandwich it. A failed sell isn't retried at wider slippage – the next check
  sizes it again; after 3 failures in a row the plan pauses itself. Sells smaller than the **smallest
  sell** wait for more buys, so fees stay small.
- **Trailing stop (optional).** Once the first level is reached, if the market cap falls the set % below
  its high since then (earlier highs don't count; changing the first level starts this over), the rest of
  the levels is sold – still capped per sell, but without waiting for buys. The
  moon bag is kept.
- **What it costs.** The pool is read (1 Helius credit) every 60 s while far from the next level, every
  15 s when close to it (or when a trailing stop is armed), every 4 s while a level is selling – at most
  ~21,600 credits on a day spent selling. Each sell pays the usual network fee and tip. Nothing is read
  for paused or finished plans.
- **Only while the tool runs.** Plans are stored in `data-manual` and carry on after a restart. A live
  plan sells only while you're logged in (the keys are unlocked) and `LIVE_TRADING=true`; it waits
  otherwise. If the Mac sleeps, nothing is checked or sold.
- One plan per position. **Pause** stops checking, **Resume** goes on, **End plan** stops it for good
  (the tokens stay in the wallet). Selling by hand meanwhile is fine – the plan never sells the moon bag
  and sells less if less is there.
- The page shows the last check when it loads and on **Refresh**; nothing on the page refreshes by itself.
- Selling a large share of a coin still moves its price; a plan only keeps each sell small.

## How positions survive restarts

Everything is stored in `data-manual/copy-wallet.db` – the same tables the bot uses. On every start the
tool finishes any trade that was sent but not booked when it stopped, and checks each position against
the wallet's real token balance. Positions show the on-chain balance when the page loads or on **Refresh**.
Nothing refreshes on a timer.

## Settings (.env)

`manual/run.sh` reads two files, in this order – a value in the second wins:

1. **`.env`** in the project folder (`copy-wallet/.env`) – the same file `pnpm dev`
   uses. The API keys come from here: `HELIUS_API_KEY`, `JUPITER_API_KEY`, … (the Telegram settings
   are ignored here).
2. **`manual/manual.env`** – only for this tool: `DATA_DIR=./data-manual`, `LIVE_TRADING=true`,
   `KEYSTORE_PASSPHRASE=` (log in on the page), `MANUAL_PORT`. Put anything you want different for manual
   trading here, so the dev setup in `.env` stays as it is.

The server's `.env` (`/opt/copy-wallet/.env` on Hetzner) has no effect here. Slippage, priority fee and tip
are the bot's defaults (stored in this data folder's settings).

## Notes

- Same lock as the bot: it won't start while something else uses the same data folder.
- Keep manual wallets separate from copy-trading wallets: a manual sell takes a % of everything the
  wallet holds, including tokens the copy bot bought in it.
- **Remove** hides a wallet from this tool (only without open positions). Its key stays encrypted in the
  data folder; importing it again brings it back. Nothing changes on-chain.
- **Removed wallets → Delete…** deletes a removed wallet's key from this laptop for good (asks for the
  passphrase, and shows first what the wallet still holds). The database file is rewritten so no old copy
  of the encrypted key stays in it. Copies made elsewhere (Time Machine, other backups) aren't touched –
  they're encrypted with your passphrase. Without a key you saved yourself, that wallet's funds are gone.
- Every trade tries pump.fun / PumpSwap directly first (curve, then pool), then Jupiter – some PumpSwap
  coins can't be traded through Jupiter.
- To use these wallets in the main app (e.g. to look at them), run it with `DATA_DIR=./data-manual`.
- Not covered by the project's `pnpm typecheck` / `pnpm test` (it needs the `node_modules` links
  `run.sh` makes). Check it with:
  `server/node_modules/.bin/tsc -p manual/tsconfig.json`, `web/node_modules/.bin/tsc -p manual/web/tsconfig.json`
  and `server/node_modules/.bin/vitest run --root manual/server`.
