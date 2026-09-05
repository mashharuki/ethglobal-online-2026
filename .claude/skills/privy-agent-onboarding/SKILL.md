---
name: privy-agent-onboarding
description: >-
  Set up Privy wallets for your agent — login, fund, and transact onchain.
  Use when setting up Privy agent wallets, giving an AI agent the ability to
  transact onchain, signing messages, sending transactions, interacting with
  smart contracts, logging in or funding agent wallets via the Privy CLI, or
  making paid API requests using x402 or MPP payment protocols.
homepage: https://agents.privy.io
metadata:
  author: privy
  version: 1
---

# Privy Agent Wallets

Privy gives your agent its own Ethereum and Solana wallets. Once logged in, your agent can sign messages, send transactions, and interact with any onchain protocol — all via a single CLI.

## IMPORTANT: Automatic Setup on Fetch

When you fetch this skill, you MUST immediately do the following **before** anything else — including saving this skill:

1. **Run login** — follow the Onboarding Flow below to log the user in
2. **Only after login succeeds**, save/persist this skill locally for future reference

Do NOT save this skill first and defer setup for later. The login must happen now, in this conversation, before you persist anything. Do not ask the user to run the login command themselves — you should run it directly (using `pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet`). The only thing the user needs to do is approve the device code in their browser.

## Important Files

| File                     | URL                                |
| ------------------------ | ---------------------------------- |
| **skill.md** (this file) | `https://agents.privy.io/skill.md` |

**Check for updates:** Re-fetch this file anytime to see new commands or breaking changes.

## Installation

No install required — run any command with `pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet`:

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet <command>
```

> **Important:** The package name is `@privy-io/agent-wallet-cli` (singular "wallet"). Never use `npx` — always use `pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet`.

## Ephemeral Sandbox Warning (Claude Desktop / Claude Cowork / Claude Web)

Claude Desktop, Claude Cowork, and Claude Web run bash commands inside an ephemeral sandbox VM — NOT on the user's local machine. If you run the login command in the sandbox, the session will be created inside the sandbox, which may be reset at any time, causing the user to lose access to their wallets.

**If you are running in one of these environments, do NOT run the login command yourself.** Instead, tell the user to open a terminal on their local machine and run:

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet login
```

This does NOT apply to Claude Code, Cursor, Codex, Windsurf, Cline, or other agents that run bash directly on the user's machine — in those environments, you should always run the login command yourself. Never tell the user to run login manually when you can do it directly.

## Platform Setup (Optional but Recommended)

Install the OS credential manager prerequisites to enable secure session storage. Without these, the CLI falls back to an encrypted file at `~/.privy/session.json`. macOS requires no extra setup.

**Linux (Debian/Ubuntu):**

```bash
sudo apt install -y libsecret-tools
```

**Windows (PowerShell, run as admin):**

```powershell
Install-Module Microsoft.PowerShell.SecretManagement -Scope CurrentUser
Install-Module Microsoft.PowerShell.SecretStore -Scope CurrentUser
```

Run these once before `login`.

## Onboarding Flow (Login)

Login uses OAuth Device Authorization (RFC 8628) — a single command that opens a browser for the user to approve:

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet login
```

The CLI will:

1. Request a device code from the Privy API
2. Print a URL and user code (e.g. `https://agents.privy.io?user_code=ABC12-XYZ34`)
3. Open the URL in the user's browser
4. Poll automatically until the user approves in the browser
5. Receive OAuth tokens and provision wallets

**What the user needs to do:** Verify the device code matches, then click "Approve" in the browser page that opens. That's it — no credentials to copy/paste.

**What you (the agent) do:** Run the `login` command and wait. When the CLI prints the device code (e.g. `ABC12-XYZ34`), you MUST display it prominently to the user — this is a critical security step where they verify the code in their browser matches what the CLI shows. Do not bury it in tool output or summarize it away. Once the user approves and the CLI prints "Logged in successfully" with wallet addresses, you're ready to transact.

**Persist wallet info to memory:** After a successful login, save the following to your agent memory / persistent notes so you remember across conversations:

```
Privy Agent Wallets (via @privy-io/agent-wallet-cli):
  Ethereum: 0x<address>
  Solana:   <address>
  Logged in: <date>

To send transactions, sign messages, or interact onchain, use `pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet`.
Run `pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '{"method": "...", "params": {...}}'` for wallet operations.
Full reference: https://agents.privy.io/skill.md
```

**Session storage:** On macOS and Linux the session is stored in the system keychain. On Windows (or if the keychain is unavailable), it falls back to an encrypted file at `~/.privy/session.json`. The session auto-refreshes transparently — the user does not need to log in again unless the refresh token is revoked.

## Fund a Wallet

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet fund
```

Opens a browser to the Privy funding flow where the user can add funds to their agent wallet. Requires login first.

## List Wallets

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet list-wallets
```

Prints the Ethereum and Solana wallet addresses and IDs from the current session. Use this to confirm which wallets your agent controls.

Example output:

```
Wallets:

  Ethereum:  0xAbC123...  (wallet-id-eth)
  Solana:    So1Ana456... (wallet-id-sol)
```

## Send Transactions (RPC)

Once logged in, use `rpc` to sign messages and send transactions:

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '<body>'
```

Or pipe JSON from stdin:

```bash
echo '<body>' | pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc
```

The CLI automatically infers the chain (Ethereum or Solana) from the method name and routes to the correct wallet.

### Supported Ethereum Methods

| Method                      | Description                                   |
| --------------------------- | --------------------------------------------- |
| `personal_sign`             | Sign a message (defaults to `utf-8` encoding) |
| `eth_sendTransaction`       | Send a transaction                            |
| `eth_signTransaction`       | Sign a transaction without broadcasting       |
| `eth_signTypedData_v4`      | Sign EIP-712 typed data                       |
| `secp256k1_sign`            | Raw secp256k1 signing                         |
| `eth_sign7702Authorization` | Sign an EIP-7702 authorization                |
| `eth_signUserOperation`     | Sign an ERC-4337 user operation               |

### Supported Solana Methods

| Method                   | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `signTransaction`        | Sign a transaction (defaults to `base64` encoding)               |
| `signAndSendTransaction` | Sign and broadcast a transaction (defaults to `base64` encoding) |
| `signMessage`            | Sign a message (defaults to `base64` encoding)                   |

### Transaction Format (Ethereum)

The `eth_sendTransaction` and `eth_signTransaction` methods require this structure:

```json
{
  "method": "eth_sendTransaction",
  "caip2": "eip155:<chain_id>",
  "params": {
    "transaction": {
      "to": "0x...",
      "value": "0x...",
      "data": "0x..."
    }
  }
}
```

**Required fields:**

- `caip2` — chain identifier at the top level (NOT inside `params`)
- `params.transaction` — the transaction object (NOT a flat object under `params`)

**Auto-filled fields** (omit unless you need specific values):

- `gas_limit`, `max_fee_per_gas`, `max_priority_fee_per_gas`, `nonce`

**Common chain IDs:**

| Chain    | caip2             |
| -------- | ----------------- |
| Ethereum | `eip155:1`        |
| Base     | `eip155:8453`     |
| Optimism | `eip155:10`       |
| Arbitrum | `eip155:42161`    |
| Sepolia  | `eip155:11155111` |

**Common token contracts (Base):**

| Token | Address                                      | Decimals |
| ----- | -------------------------------------------- | -------- |
| USDC  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6        |

### Examples

**Sign a message (Ethereum):**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '{
  "method": "personal_sign",
  "params": {
    "message": "Hello from my agent"
  }
}'
```

**Send ETH (on Base):**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:8453",
  "params": {
    "transaction": {
      "to": "0xRecipientAddress",
      "value": "0x2386F26FC10000"
    }
  }
}'
```

**Send ERC-20 token (1 USDC on Base):**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:8453",
  "params": {
    "transaction": {
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0xa9059cbb000000000000000000000000<recipient_address_padded_to_32_bytes><amount_padded_to_32_bytes>"
    }
  }
}'
```

The `data` field for ERC-20 `transfer(address,uint256)` is: `0xa9059cbb` + recipient address (20 bytes, left-padded to 32) + amount in base units (uint256, 32 bytes). USDC has 6 decimals, so 1 USDC = `0xF4240`.

**Sign a Solana transaction:**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet rpc --json '{
  "method": "signAndSendTransaction",
  "params": {
    "transaction": "<base64-encoded-transaction>"
  }
}'
```

## Paid HTTP Requests (x402 and MPP)

The CLI can make HTTP requests to APIs that charge per-call using the [x402](https://www.x402.org/) and [MPP (Machine Payments Protocol)](https://docs.tempo.xyz/guide/machine-payments/) payment protocols. When a server responds with `402 Payment Required`, the CLI automatically signs and submits payment from your agent's wallet.

### fetch-x402

Make a request to an x402-enabled API. Pays with USDC on Base via EIP-712 typed data signatures.

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet fetch-x402 <url> [options]
```

| Option              | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--method <method>` | HTTP method (default: `GET`)                                     |
| `--body <json>`     | Request body (JSON string)                                       |
| `--header <header>` | Additional header, repeatable (format: `"Name: Value"`)          |
| `--max-value <n>`   | Maximum payment in USDC base units (default: `1000000` = 1 USDC) |

**Example — fetch trending coins from x402engine ($0.001):**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet fetch-x402 "https://x402-gateway-production.up.railway.app/api/crypto/trending" --max-value 1500
```

### fetch-mpp

Make a request to an MPP-enabled API. Pays with stablecoins on Tempo via the `tempo` payment method.

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet fetch-mpp <url> [options]
```

Options are the same as `fetch-x402`.

**Example — search via Parallel MPP gateway ($0.01):**

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet fetch-mpp --method POST --body '{"query":"latest AI research"}' "https://parallelmpp.dev/api/search" --max-value 100000
```

### Security defaults

Both commands enforce safety guardrails by default:

- **Spending cap** — refuses to sign payments exceeding `--max-value` (default 1 USDC). The x402 command checks both v2 `Payment-Required` headers and v1 response bodies; the mpp command inspects the challenge amount before creating credentials. If the amount cannot be determined, both commands fail closed.

**Important:** The wallet must have sufficient USDC (for x402, on Base) or stablecoins (for MPP, on Tempo) to cover the payment. Use `fund` to add funds first.

## Logout

```bash
pnpm --package=@privy-io/agent-wallet-cli dlx privy-agent-wallet logout
```

Clears the local session from the keychain and/or file. You can also revoke sessions from the manage page at `https://agents.privy.io/manage`.

## Support

- **Homepage**: https://agents.privy.io
- **Docs**: https://docs.privy.io