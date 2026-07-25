// c1-router.mjs — 0G Compute inference smoke test (spike, hackathon speed)
//
// Two independent paths, both gated by what's actually funded/configured:
//   1. Direct/Broker path  — @0gfoundation/0g-compute-ts-sdk, wallet-signed, needs 0G deposited
//      into the on-chain Ledger contract (testnet). Read-only steps (broker init, listService)
//      work with zero balance; anything past the ledger-balance check is gated off.
//   2. Hosted Router path  — router-api.0g.ai/v1, Anthropic-compatible /v1/messages, needs only
//      a plain API key (ROUTER_API_KEY env var). Gated off entirely if that key isn't set.
//
// Run: node c1-router.mjs

import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import Anthropic from '@anthropic-ai/sdk'

// ---------------------------------------------------------------------------
// 1. Load .env manually (no dotenv dependency)
// ---------------------------------------------------------------------------
function loadEnv(file) {
    const out = {}
    const raw = fs.readFileSync(file, 'utf8')
    for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let val = trimmed.slice(eq + 1).trim()
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1)
        }
        out[key] = val
    }
    return out
}

const envPath = path.join(process.cwd(), '.env')
const env = loadEnv(envPath)

const PRIVATE_KEY = env.PRIVATE_KEY
const ADDRESS = env.ADDRESS
const RPC = env.RPC || 'https://evmrpc-testnet.0g.ai'
const ROUTER_API_KEY = env.ROUTER_API_KEY || process.env.ROUTER_API_KEY

if (!PRIVATE_KEY || !ADDRESS) {
    console.error('Missing PRIVATE_KEY or ADDRESS in .env — cannot continue.')
    process.exit(1)
}

console.log('=== c1-router.mjs: 0G Compute inference smoke test ===')
console.log(`RPC: ${RPC}`)
console.log(`Wallet address (from .env): ${ADDRESS}`)
console.log('')

// ---------------------------------------------------------------------------
// 2. Broker path — createZGComputeNetworkBroker(wallet)
//    API confirmed from node_modules/@0gfoundation/0g-compute-ts-sdk/README.md
//    and types/broker.d.ts (this is the current, non-deprecated package).
// ---------------------------------------------------------------------------
async function main() {
    console.log('--- [Broker] init ---')
    const provider = new ethers.JsonRpcProvider(RPC)
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider)

    if (wallet.address.toLowerCase() !== ADDRESS.toLowerCase()) {
        console.warn(
            `WARNING: derived address ${wallet.address} does not match .env ADDRESS ${ADDRESS}`
        )
    }

    const broker = await createZGComputeNetworkBroker(wallet)
    console.log('Broker created via createZGComputeNetworkBroker(wallet). OK.')
    console.log('')

    // -----------------------------------------------------------------------
    // 3. List available inference services (read-only, should work unfunded)
    // -----------------------------------------------------------------------
    console.log('--- [Broker] listService() (read-only, no funds needed) ---')
    let services = []
    try {
        services = await broker.inference.listService()
        console.log(`Found ${services.length} service(s):\n`)
        for (const s of services) {
            const inputPriceNeuron = s.inputPrice
            const outputPriceNeuron = s.outputPrice
            console.log(
                `  provider=${s.provider}\n` +
                    `    model=${s.model}  type=${s.serviceType}  verifiability=${s.verifiability || '(none)'}\n` +
                    `    url=${s.url}\n` +
                    `    inputPrice=${inputPriceNeuron.toString()} neuron/token  outputPrice=${outputPriceNeuron.toString()} neuron/token\n` +
                    `    teeSignerAcknowledged=${s.teeSignerAcknowledged}\n`
            )
        }
    } catch (err) {
        console.error('listService() failed:', err.message || err)
    }
    console.log('')

    if (services.length === 0) {
        console.log('No services returned — nothing to run inference against. Stopping.')
        await runRouterProbe()
        return
    }

    // -----------------------------------------------------------------------
    // 4. Check ledger balance
    // -----------------------------------------------------------------------
    console.log('--- [Broker] ledger balance check ---')
    let availableBalance = 0n
    let ledgerExists = true
    try {
        const ledger = await broker.ledger.getLedger()
        availableBalance = ledger.availableBalance
        console.log(
            `Ledger found. availableBalance=${availableBalance.toString()} neuron ` +
                `(${ethers.formatEther(availableBalance)} 0G), ` +
                `totalBalance=${ledger.totalBalance.toString()} neuron`
        )
    } catch (err) {
        ledgerExists = false
        console.log(
            `getLedger() failed (likely: no ledger created yet for this wallet). ` +
                `Error: ${err.message || err}`
        )
    }

    if (!ledgerExists || availableBalance === 0n) {
        console.log('')
        console.log(`FUND ME: ${wallet.address}`)
        console.log('Deposit call needed (creates ledger if missing, else tops up):')
        console.log('  await broker.ledger.depositFund(<amount_in_0G_as_number>)')
        console.log('  e.g. await broker.ledger.depositFund(10)   // 10 0G, min ~3 0G to create a ledger')
        console.log('Then, per-provider funding (required before use, auto-acknowledges TEE signer):')
        console.log('  await broker.ledger.transferFund(providerAddress, "inference", 1_000_000_000_000_000_000n) // 1 0G, in neuron (wei-like, 1e18 neuron = 1 0G)')
        console.log('')
        console.log('Wallet is not funded. Exiting cleanly before any funded/spending calls.')
        await runRouterProbe()
        return
    }

    // -----------------------------------------------------------------------
    // 5. FUNDED PATH — only runs if availableBalance > 0
    // -----------------------------------------------------------------------
    await runFundedInference(broker, services[0])
    await runRouterProbe()
}

async function runFundedInference(broker, service) {
    console.log('')
    console.log('--- [Broker] FUNDED PATH: running one chat completion ---')
    const providerAddress = service.provider

    // Ensure provider sub-account has funds / is acknowledged.
    const acked = await broker.inference.acknowledged(providerAddress)
    if (!acked) {
        console.log(`Provider ${providerAddress} not yet acknowledged — acknowledging + transferring funds...`)
        await broker.ledger.transferFund(providerAddress, 'inference', ethers.parseEther('1'))
        await broker.inference.acknowledgeProviderSigner(providerAddress)
    }

    const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress)
    const headers = await broker.inference.getRequestHeaders(providerAddress, 'Hello!')

    const res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Hello! Reply in one short sentence.' }],
        }),
    })
    const json = await res.json()
    console.log('Response:', JSON.stringify(json, null, 2))
    const text = json?.choices?.[0]?.message?.content
    console.log('')
    console.log('Chat completion text:', text)

    const chatID = res.headers.get('ZG-Res-Key') || json?.id
    if (chatID) {
        const usage = json?.usage ? JSON.stringify(json.usage) : undefined
        const valid = await broker.inference.processResponse(providerAddress, chatID, usage)
        console.log('processResponse (TEE signature check) ->', valid)
    }
}

// ---------------------------------------------------------------------------
// 6. Hosted Router probe — router-api.0g.ai/v1, Anthropic-compatible
//    /v1/messages, X-0G-Provider-Trust-Mode: private.
//    Gated on ROUTER_API_KEY being set — needs only an API key, no broker/wallet.
// ---------------------------------------------------------------------------
async function runRouterProbe() {
    console.log('')
    console.log('--- [Router] hosted router-api.0g.ai probe ---')

    if (!ROUTER_API_KEY) {
        console.log('ROUTER_API_KEY not set in .env / env — skipping funded Router call.')
        console.log('To get one:')
        console.log('  1. Visit https://pc.0g.ai, connect wallet (one-time interactive sign-in).')
        console.log('  2. Deposit 0G to the Payment Layer contract (testnet: 0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939).')
        console.log('  3. Dashboard -> API Keys -> create an sk-... key (or POST /v1/api-keys with an mk- key).')
        console.log('  4. Set ROUTER_API_KEY=sk-... in .env and re-run this script.')
        console.log('')
        console.log('Read-only check that works without a key (GET /v1/models, no auth):')
        try {
            const res = await fetch('https://router-api-testnet.integratenetwork.work/v1/models')
            if (res.ok) {
                const json = await res.json()
                const list = json.data || json.models || []
                console.log(`  Router testnet /v1/models -> ${list.length} models (unauthenticated, read-only).`)
                for (const m of list.slice(0, 5)) {
                    console.log(`    - ${m.id}  verifiability=${m.verifiability ?? '(none)'}  formats=${(m.supported_formats || []).join(',')}`)
                }
            } else {
                console.log(`  GET /v1/models -> HTTP ${res.status}`)
            }
        } catch (err) {
            console.log(`  GET /v1/models failed: ${err.message || err}`)
        }
        return
    }

    console.log('ROUTER_API_KEY is set — calling /v1/messages via @anthropic-ai/sdk ...')
    const client = new Anthropic({
        apiKey: ROUTER_API_KEY,
        baseURL: 'https://router-api.0g.ai/v1',
        defaultHeaders: {
            'X-0G-Provider-Trust-Mode': 'private', // restrict routing to TeeML (model-in-enclave) providers
        },
    })

    try {
        const msg = await client.messages.create({
            model: 'claude-sonnet-5',
            max_tokens: 256,
            messages: [{ role: 'user', content: 'Hello! Reply in one short sentence.' }],
        })
        console.log('Router /v1/messages response:')
        console.log(JSON.stringify(msg, null, 2))
        const text = msg.content?.map((c) => c.text).join('')
        console.log('')
        console.log('Router chat text:', text)
    } catch (err) {
        console.error('Router /v1/messages call failed:', err.message || err)
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
