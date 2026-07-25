#!/usr/bin/env node
// c1b — funded leg of the C1 probe: create ledger, fund provider, one TEE completion.
import fs from 'node:fs';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

const env = Object.fromEntries(
  fs.readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const provider = new ethers.JsonRpcProvider(env.RPC);
const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
console.log('wallet:', wallet.address, '| balance:', ethers.formatEther(await provider.getBalance(wallet.address)), '0G');

const broker = await createZGComputeNetworkBroker(wallet);
const PROVIDER = '0xa48f01287233509FD694a22Bf840225062E67836'; // qwen2.5-omni-7b, TeeML

// 1. Ledger: create with 3 0G if missing, else report balance.
let ledger = null;
try { ledger = await broker.ledger.getLedger(); } catch { /* no ledger yet */ }
if (!ledger) {
  console.log('[1] no ledger — depositing 3 0G to create...');
  await broker.ledger.depositFund(3);
  ledger = await broker.ledger.getLedger();
}
console.log('[1] PASS ledger — total:', ethers.formatEther(ledger.totalBalance ?? 0n), '0G, available:', ethers.formatEther(ledger.availableBalance ?? 0n), '0G');

// 2. Provider sub-account: transfer 1 0G (auto-acks TEE signer) if not acknowledged.
const acked = await broker.inference.acknowledged(PROVIDER).catch(() => false);
if (!acked) {
  console.log('[2] funding provider sub-account with 1 0G + acknowledging TEE signer...');
  await broker.ledger.transferFund(PROVIDER, 'inference', ethers.parseEther('1'));
  await broker.inference.acknowledgeProviderSigner(PROVIDER);
}
console.log('[2] PASS provider acknowledged');

// 3. One chat completion, TEE-verified.
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log('[3] endpoint:', endpoint, '| model:', model);
const question = 'Reply in one short sentence: what is private inference?';
const headers = await broker.inference.getRequestHeaders(PROVIDER, question);
const t0 = Date.now();
const res = await fetch(`${endpoint}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: question }] }),
});
const body = await res.json();
const latency = Date.now() - t0;
if (!res.ok) { console.error('[3] FAIL HTTP', res.status, JSON.stringify(body).slice(0, 400)); process.exit(1); }
const answer = body.choices?.[0]?.message?.content;
console.log('[3] PASS completion in', latency, 'ms:', JSON.stringify(answer));

// 4. TEE response verification.
try {
  const valid = await broker.inference.processResponse(PROVIDER, body.id, JSON.stringify(body.usage ?? {}));
  console.log('[4]', valid ? 'PASS' : 'WARN', 'TEE signature verification ->', valid);
} catch (e) {
  console.log('[4] WARN processResponse threw:', e.message?.slice(0, 200));
}
console.log('\n=== C1 FUNDED LEG DONE ===');
