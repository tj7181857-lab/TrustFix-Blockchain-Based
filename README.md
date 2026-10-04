# TrustTix — Multi-Event Blockchain Ticketing

A complete full-stack blockchain application for a college course demo. Every
ticket is an ERC-721 NFT managed by the TrustTix multi-event contract on a
local Hardhat network. The monitoring service uses transparent heuristic
signals derived from actual on-chain purchase logs; it is not an AI model and
wallet relationships do not prove common ownership.

---

## What this project does

| Feature | How it works |
|---|---|
| NFT ticket purchase | Buyer pays ETH → ERC-721 token transferred to their wallet on-chain |
| Event registry | Organizer creates multiple independent events on-chain |
| NFT ticket purchase | Buyer pays event-specific ETH → ERC-721 token transferred to their wallet on-chain |
| Role separation | Contract owner is the organizer; attendee wallets purchase, while the organizer cannot buy tickets |
| Analytics | One backend response combines on-chain event inventory with replayed purchase logs and event-scoped aggregates |
| Risk monitoring | Backend replays `TicketPurchased` logs and reports event-scoped heuristic signals |
| Organizer dashboard | Event sales, inventory, revenue, purchase transactions, risk signals, and organizer-authorized ticket actions |
| Gate verification | Staff reads ticket state and signs an on-chain use transaction with MetaMask |
| Simulation scripts | Real on-chain transactions — the dashboard reacts to them exactly like real users |

---

## Prerequisites

You need these installed before anything else.

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | v18+ (v22 recommended) | https://nodejs.org |
| npm | v9+ | comes with Node |
| MetaMask browser extension | any | https://metamask.io |
| Git | any | https://git-scm.com |

Check your versions:
```bash
node --version   # should print v18.x or higher
npm --version    # should print 9.x or higher
```

You do **not** need to install Hardhat globally — all commands use `npx`.

---

## Project structure

```
Blockchaincp/
├── contracts/
│   ├── TrustTix.sol              ← legacy single-event ticket contract
│   └── TrustTixMultiEvent.sol    ← multi-event ERC-721 registry contract
├── test/
│   ├── TrustTix.test.js          ← legacy Hardhat/Mocha/Chai tests
│   └── TrustTixMultiEvent.test.js← multi-event contract tests
├── scripts/
│   ├── deploy.js                 ← deploys contract + creates event
│   ├── deploy-multi-event.js     ← deploys new multi-event contract
│   ├── simulate-normal-buyers.js ← legitimate purchase simulation
│   └── simulate-scalper-attack.js← scalper cluster simulation
├── server/
│   ├── index.js                  ← Express + Socket.io API server
│   ├── chainListener.js          ← subscribes to on-chain events
│   ├── riskEngine.js             ← fraud scoring logic (documented)
│   └── TrustTix.json             ← ABI (auto-copied by deploy.js)
├── client/
│   └── src/
│       ├── views/
│       │   ├── BuyerView.jsx     ← buy tickets, see My Tickets
│       │   ├── OrganizerView.jsx ← live dashboard + cluster graph
│       │   └── GateView.jsx      ← entry verification
│       ├── hooks/                ← useWallet, useContract, useSocket
│       └── components/           ← shared UI pieces
├── hardhat.config.js
├── .env.example                  ← copy to .env and fill in values
└── README.md
```

## Multi-event contract architecture

The original `TrustTix` contract is the **old single-event demo**: one deployed
contract represents one event. Its existing deployment record remains in
`deployment.json`; this deployment is not upgraded or migrated.

`TrustTixMultiEvent` is the **new multi-event architecture**: one ERC-721
contract maintains an on-chain event registry. The organizer creates an event
on-chain, the contract assigns a sequential event ID, and each ticket records
that event ID alongside its global token ID. Inventory, price, sold count,
availability, and wallet purchase limits are tracked independently per event.
Organizer-only event and ticket operations remain enforced by the contract;
owner-approved staff can mark tickets used.

Deploy the new contract separately:

```bash
npx hardhat run scripts/deploy-multi-event.js --network localhost
```

This writes `deployment-multi-event.json` and copies its ABI to
`server/TrustTixMultiEvent.json`. It does not overwrite `deployment.json`, create
a default event, or make fake purchase history. The new contract starts with
zero events. Old event and ticket data is not migrated; the old deployment
remains available for reference.

---

## Current multi-event setup

These are the commands for the current application. They deploy the new
`TrustTixMultiEvent` contract, whose address and ABI are consumed from
`deployment-multi-event.json` and `server/TrustTixMultiEvent.json`. Do not use
the legacy `deploy.js` command for the current multi-event UI/backend.

```bash
# Run contract and risk-engine regression tests
npx hardhat test

# Terminal 1: start a fresh local chain
npx hardhat node

# Terminal 2: deploy the multi-event contract (creates no fake events or tickets)
npx hardhat run scripts/deploy-multi-event.js --network localhost

# Terminal 3: start the multi-event API and historical log indexer
npm start --prefix server

# Terminal 4: start the frontend
npm run dev --prefix client
```

Connect MetaMask to **Hardhat Local**, chain ID `31337`. Use the deployer wallet
as organizer; use other local Hardhat accounts as attendees or gate staff.
Ticket purchases, event creation, ticket use, and organizer ticket controls
are signed through MetaMask. The backend rebuilds purchase and risk history
from contract logs after it starts. Restarting a fresh Hardhat node clears its
state; run the deployment command again and reconnect MetaMask.

The application separates organizer pages from attendee browsing and purchase
pages. The organizer dashboard, Analytics, and Risk Monitor share data from
`GET /api/analytics`: event inventory and sold counts are read from the
contract, and buyer/transaction history is reconstructed from indexed
`TicketPurchased` logs. The backend replays those logs before accepting
requests after startup. The contract rejects organizer purchases through both
single-ticket and bulk-ticket purchase methods. Historical purchase risks are
heuristic signals; they are not identity assertions or proof of fraud.

## Legacy single-event reference

The remaining detailed setup, simulation, and troubleshooting notes below
describe the previous single-event `TrustTix.sol` demo and its private-key
backend flow. They are retained for reference only and do not configure the
current multi-event application.

## Legacy full setup and run guide

Follow these steps **in order**. Each section opens a new terminal tab —
keep them all running during the demo.

---

### Step 1 — Clone and install root dependencies

```bash
# If you haven't cloned yet:
git clone <your-repo-url>
cd Blockchaincp

# Install Hardhat + OpenZeppelin + testing tools
npm install
```

This installs everything in the root `node_modules/` needed for:
- Hardhat (blockchain framework)
- OpenZeppelin contracts (ERC-721 base)
- Testing tools (Mocha, Chai, ethers)

---

### Step 2 — Run the test suite

Before doing anything else, verify the smart contract passes all tests:

```bash
npx hardhat test
```

Expected output:
```
  TrustTix — Deployment & Setup
    ✓ deploys with correct ERC-721 name/symbol
    ✓ creates event with correct parameters
    ... (39 tests total)

  39 passing (2s)
```

If any tests fail, stop here — something is wrong with the environment.

---

### Step 3 — Start the local Hardhat node

**Open Terminal 1** and run:

```bash
npx hardhat node
```

Leave this terminal running. You will see output like:

```
Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/

Accounts
========
Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000 ETH)
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (10000 ETH)
Private Key: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
...
```

> **Important:** These account addresses and private keys are the same every
> time you start a fresh Hardhat node. They are publicly known test accounts —
> never use them on mainnet or with real money.

---

### Step 4 — Set up the environment file

Copy `.env.example` to `.env`:

```bash
# Mac/Linux:
cp .env.example .env

# Windows PowerShell:
Copy-Item .env.example .env
```

Edit `.env` and fill in these values:

```env
RPC_URL=http://127.0.0.1:8545
CONTRACT_ADDRESS=          # leave blank for now — filled in Step 5
ORGANIZER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PORT=3001
```

> The `ORGANIZER_PRIVATE_KEY` above is Account #0 from Hardhat — the deployer.
> It is a well-known public test key. **Only use it on the local Hardhat
> network.**

---

### Step 5 — Deploy the contract

**In a new terminal (Terminal 2):**

```bash
npx hardhat run scripts/deploy.js --network localhost
```

Expected output:
```
=== TrustTix Deployment ===
Network  : localhost
Deployer : 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Balance  : 10000.0 ETH

Deploying TrustTix...
✓ TrustTix deployed to: 0x5FbDB2315678afecb367f032d93F642f64180aa3
Creating event...
  Name         : TrustTix Demo Concert 2026
  Tickets      : 30
  Price        : 0.01 ETH
  Max / wallet : 2
✓ Event created (tx: 0x56fda0...)
✓ Available tickets in pool: 30
✓ Deployment info saved to deployment.json
✓ ABI copied to server/TrustTix.json
```

Now copy the contract address into `.env`:

```env
CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
```

> The address shown on your machine may differ if you have restarted the
> Hardhat node. Always use the address printed by `deploy.js`, not a hardcoded
> value.

`deploy.js` also writes `deployment.json` in the project root. The backend
reads that file automatically, so if you forget to update `.env` it will still
pick up the right address.

---

### Step 6 — Install and start the backend

```bash
# Install backend dependencies (first time only)
cd server
npm install

# Start the detection service
npm start
```

Expected output:
```
=== TrustTix Detection Service ===
Contract : 0x5FbDB2315678afecb367f032d93F642f64180aa3
RPC      : http://127.0.0.1:8545
Port     : 3001

[ChainListener] Connected. Current block: 2
[ChainListener] Replaying past TicketPurchased events…
[ChainListener] Found 0 past purchase event(s).
[ChainListener] Subscribed to contract events.

✓ Server running at http://localhost:3001
```

Leave this running. You can verify it is alive:
```bash
# In any terminal:
curl http://localhost:3001/api/health
# → {"status":"ok","contract":"0x5FbDB...","organizerReady":true}
```

Available REST endpoints:

| Endpoint | Description |
|---|---|
| `GET /api/health` | Server status |
| `GET /api/event` | Event info (name, tickets sold/available, price) |
| `GET /api/tickets` | All purchased ticket info |
| `GET /api/risk-scores` | Risk scores for all tracked wallets |
| `GET /api/clusters` | Detected scalper clusters |
| `GET /api/graph` | Graph nodes + edges for visualization |
| `GET /api/ticket/:tokenId` | Single ticket info (used by gate view) |
| `POST /api/freeze/:tokenId` | Freeze a ticket (organizer action) |
| `POST /api/revoke/:tokenId` | Revoke & refund a ticket |
| `POST /api/clear/:tokenId` | Clear a frozen ticket's flag |
| `POST /api/mark-used/:tokenId` | Mark a ticket used at entry |

---

### Step 7 — Install and start the frontend

```bash
# From the project root:
cd client
npm install

# Start the Vite dev server:
npm run dev
```

Expected output:
```
  VITE v6.x  ready in 861 ms

  ➜  Local:   http://localhost:5173/
```

Open **http://localhost:5173** in your browser.

---

### Step 8 — Connect MetaMask to the local network

1. Open MetaMask → click the network dropdown → **Add a network manually**.

2. Fill in:
   - **Network name:** Hardhat Local
   - **New RPC URL:** `http://127.0.0.1:8545`
   - **Chain ID:** `31337`
   - **Currency symbol:** `ETH`

3. Click **Save**, then switch to the Hardhat Local network.

4. Import a test account so you have ETH to buy tickets:
   - MetaMask → **Import account** → paste this private key:
   ```
   0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
   ```
   This is Hardhat Account #1 (10,000 ETH).

   > Import a second account if you want to test the wallet-limit enforcement.
   > Use Account #2's key:
   > `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`

5. Go back to the TrustTix app at http://localhost:5173 and click
   **Connect MetaMask**.

---

## Running the live demo

### Buy tickets (Buyer view)

1. Navigate to **🎟 Buy Tickets**.
2. Click any seat number (shown as a grid).
3. Confirm the transaction in MetaMask (0.01 ETH + gas).
4. Your ticket appears in **My Tickets** below the grid.
5. Switch to a second MetaMask account and buy more — the grid updates live.

---

### Watch the organizer dashboard react in real time

1. Navigate to **📊 Organizer** — you'll see:
   - Stats bar: tracked wallets, high/medium risk counts, clusters found.
   - A live risk-score chart that plots each purchase as it arrives.
   - The wallet cluster graph (empty until scalpers are simulated).
   - The full risk-score table for every wallet.

2. Run the **normal buyers simulation** in a terminal:
   ```bash
   npx hardhat run scripts/simulate-normal-buyers.js --network localhost
   ```
   Watch the dashboard update in real time. Normal buyers score around 20
   (new-wallet signal only — no shared funding, no timing burst).

---

### Live scalper detection demo

This is the main demo moment. Have the Organizer dashboard open.

In a terminal, run:
```bash
npx hardhat run scripts/simulate-scalper-attack.js --network localhost
```

What the script does (all real on-chain transactions):
1. Funds 9 fresh wallets from a single source wallet.
2. All 9 wallets buy their maximum 2 tickets each within ~4 seconds.

What you will see on the dashboard **within seconds**:
- The **cluster graph** lights up: a gold "source" node with 9 red "HIGH risk" nodes connected to it.
- The **risk score table** shows those 9 wallets jumping to **score 90**.
- A **"Detected Clusters"** panel appears with the source address and member list.

Scoring breakdown (visible in the table):
| Signal | Points | Reason |
|---|---|---|
| Shared funding source (9 wallets) | +40 | All funded by the same wallet |
| Burst purchase timing (<10s apart) | +30 | All bought within 4 seconds |
| New wallet (<10 min old) | +20 | Wallets created moments before buying |
| **Total** | **90** | **HIGH risk** |

---

### Freeze / Revoke / Clear Flag

In the Organizer view, expand a detected cluster and use the action buttons:

- **Freeze** — marks a SOLD ticket as FROZEN. The owner still holds the NFT
  but cannot use it for entry and cannot transfer it. The contract enforces
  this — it is not just a frontend check.

- **Revoke & Refund** — burns the NFT, refunds the original 0.01 ETH to the
  buyer's wallet, and re-pools a new ticket with the same seat number.

- **Clear Flag** — removes the FROZEN status (for confirmed false positives).
  The ticket goes back to SOLD and can be used normally.

Each button calls the backend (`POST /api/freeze/:tokenId`, etc.) which uses
the organizer's private key from `.env` to submit a real contract transaction.
The buyer view updates on the next poll cycle.

---

### Gate / entry verification

1. Navigate to **🚪 Gate Verify**.
2. Enter the Token ID of a ticket you bought (shown on the ticket card in
   Buyer view as "Token #N").
3. Optionally enter the owner's wallet address for an extra ownership check.
4. Click **Verify Ticket**.
5. For a valid ticket you'll see a large green **VALID — ADMIT** screen.
6. Click **Confirm Entry — Mark Used** to call `markUsed` on-chain.
7. Verify the same token again — you will get **DENIED** (ticket already used).
8. Try a frozen ticket's token ID — also **DENIED** with the freeze reason.

---

## Redeploying to Sepolia testnet

When you are ready to move off the local network:

1. Get a free Alchemy RPC URL: https://www.alchemy.com  
   Select **Ethereum** → **Sepolia** and copy the HTTPS URL.

2. Get Sepolia ETH from a faucet: https://sepoliafaucet.com

3. Add to `.env`:
   ```env
   SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
   PRIVATE_KEY=0xYOUR_REAL_SEPOLIA_WALLET_PRIVATE_KEY
   ```

4. Deploy:
   ```bash
   npx hardhat run scripts/deploy.js --network sepolia
   ```

5. Update `.env` with the new `CONTRACT_ADDRESS` printed by deploy.js.

6. Update `client/src/contractConfig.js` → `VITE_CONTRACT_ADDRESS` (or set
   `VITE_CONTRACT_ADDRESS` in `client/.env`).

7. Change `RPC_URL` in `.env` to the Sepolia RPC URL.

8. Restart the backend server.

9. Point MetaMask to Sepolia (it is built-in — no manual network needed).

> The simulation scripts (`simulate-normal-buyers.js` /
> `simulate-scalper-attack.js`) use Hardhat pre-funded accounts and will
> **not** work on Sepolia without funding real wallets with test ETH first.
> On Sepolia, buy tickets manually through the frontend or write new simulation
> scripts that use funded Sepolia accounts.

---

## How the fraud detection works

The detection service (`server/riskEngine.js`) calculates a **0–100 risk score**
for every buyer wallet using three independent on-chain signals. Scores are
additive and clamped to 100.

### Signal 1 — Shared Funding Source (max +40 pts)

For each buyer wallet, the service finds the **first-ever incoming ETH
transaction** to that wallet by scanning blocks from the beginning of the chain.
The sender of that transaction is the "funding source."

If the same source address funded **3 or more** buyer wallets → each gets **+40 pts**.  
If the same source funded exactly **2** buyer wallets → **+20 pts** each.

*Why this matters:* A scalper creates many fresh wallets to bypass the
per-wallet ticket limit. All of them receive their ETH from one master wallet.
This shared-origin relationship is the strongest fraud signal.

### Signal 2 — Burst Purchase Timing (max +30 pts)

For each wallet in a funding cluster, the service compares the timestamps of
their `TicketPurchased` events.

If any cluster-mate bought a ticket within **10 seconds** → **+30 pts**.  
If any cluster-mate bought within **60 seconds** → **+15 pts**.

*Why this matters:* Bots submit transactions almost simultaneously. Legitimate
human buyers arrive spread across minutes or hours.

### Signal 3 — New Wallet (max +20 pts)

The service measures how old the buyer wallet is at the time of purchase by
comparing the purchase block timestamp with the earliest block in which the
wallet appears on-chain.

Wallet first active **< 10 minutes** before purchase → **+20 pts**.  
Wallet first active **< 60 minutes** before purchase → **+10 pts**.

*Why this matters:* Scalpers spin up fresh wallets just before an attack.
Legitimate buyers have wallets with some prior history.

### Risk bands

| Score | Level | Color | Action |
|---|---|---|---|
| 0–29 | LOW | Green | Normal buyer |
| 30–59 | MEDIUM | Amber | Monitor |
| 60–100 | HIGH | Red | Auto-flagged for organizer review |

A full scalper pattern (shared funding + burst timing + new wallet) scores **90**.

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Hardhat Local Node                        │
│             http://127.0.0.1:8545  (chain 31337)            │
│                                                             │
│   TrustTix.sol  ←─── deploy.js creates event (30 tickets)  │
│   ERC-721 NFT contract                                      │
└───────────┬─────────────────────────┬───────────────────────┘
            │ eth_call (reads)         │ TicketPurchased events
            │                          │ TicketFrozen / Revoked
            ▼                          ▼
┌───────────────────┐      ┌──────────────────────────────────┐
│   React Frontend  │      │    Node.js Detection Service     │
│   localhost:5173  │      │    localhost:3001                │
│                   │      │                                  │
│  BuyerView        │◄────►│  chainListener.js                │
│  OrganizerView    │  WS  │  ├─ listens for events           │
│  GateView         │      │  ├─ scans blocks for funding src  │
│                   │      │  └─ feeds riskEngine.js          │
│  ethers.js v6     │      │                                  │
│  MetaMask wallet  │      │  riskEngine.js                   │
│                   │      │  ├─ Signal 1: shared funding +40  │
│                   │      │  ├─ Signal 2: burst timing   +30  │
│                   │      │  └─ Signal 3: new wallet    +20  │
│                   │      │                                  │
│                   │◄────►│  REST API  /api/*                │
│                   │ HTTP │  Socket.io (live push)           │
└───────────────────┘      └──────────────────────────────────┘
            │
            │ sendTransaction (buyTicket, markUsed, etc.)
            ▼
       MetaMask → signs tx → Hardhat node
```

---

## Troubleshooting

### "Cannot connect to network" / frontend shows contract errors

- Make sure Terminal 1 (`npx hardhat node`) is still running.
- Make sure MetaMask is on **Hardhat Local (chain 31337)**, not Ethereum mainnet.
- Re-run `deploy.js` if you restarted the Hardhat node (it resets all state).
- Update `CONTRACT_ADDRESS` in `.env` after every fresh deploy.

### "ORGANIZER_PRIVATE_KEY not set" in backend logs

- The freeze/revoke/clear/markUsed endpoints require this key.
- Copy the key from the Hardhat node output (Account #0's private key).
- Add it to `.env` as `ORGANIZER_PRIVATE_KEY=0xac0974bec...`.

### MetaMask shows "nonce too high" or wrong balance

- The Hardhat node resets on restart. Reset MetaMask's account nonce:  
  **MetaMask → Settings → Advanced → Clear activity and nonce data**.

### Backend not detecting scalper cluster scores (stuck at 20)

- The block scan in `chainListener.js` runs during event replay on startup.
- If the server started **before** the simulation, it replays events correctly.
- If you see scores stuck at 20, restart the backend (`npm start` in `server/`).
  It will replay all past events from block 0, detect funding sources, and
  recalculate scores.

### `npx hardhat test` fails to compile

- Ensure you have not changed `"type"` in the root `package.json`
  (must be `"commonjs"` for Hardhat 2).
- The Solidity compiler is `0.8.26` with `evmVersion: "cancun"` — required by
  OpenZeppelin 5.x. Do not downgrade either.

### Frontend build error: "Cannot find module artifacts/contracts/..."

- Run `npx hardhat compile` first to generate the artifact.
- Or run `npx hardhat run scripts/deploy.js` — it compiles as a side effect.

---

## Quick-start command reference

```bash
# Terminal 1 — keep running throughout the demo
npx hardhat node

# Terminal 2 — run once per fresh Hardhat node start
npx hardhat run scripts/deploy.js --network localhost

# Terminal 3 — keep running throughout the demo
cd server && npm start

# Terminal 4 — keep running throughout the demo
cd client && npm run dev

# Terminal 5 (demo commands — run when dashboard is open)
npx hardhat run scripts/simulate-normal-buyers.js --network localhost
npx hardhat run scripts/simulate-scalper-attack.js --network localhost

# Verification
npx hardhat test
```

Open **http://localhost:5173** in your browser after all four terminals are up.

---

## Tech stack summary

| Layer | Technology | Version |
|---|---|---|
| Smart contract | Solidity | ^0.8.26 |
| Contract framework | Hardhat | 2.22.19 |
| NFT standard | OpenZeppelin ERC-721 | 5.6.1 |
| Contract testing | Mocha + Chai + Hardhat | — |
| Backend runtime | Node.js + Express | v24 / v5 |
| On-chain listener | Ethers.js | v6 |
| Real-time push | Socket.io | v4 |
| Frontend framework | React + Vite | v18 / v6 |
| Wallet connection | MetaMask (BrowserProvider) | ethers v6 |
| Cluster graph | react-force-graph-2d | v1 |
| Charts | Recharts | v2 |
| Styling | Tailwind CSS | v3 |
