import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { AgentClient } = require('/root/.openclaw/workspace/agent-identity-sdk/src/index.js');
const { Keypair, Connection } = require('@solana/web3.js');
const fs = require('fs');

// Use the frankie_wallet as the authority (it's our operator wallet)
const bs58mod = require('bs58');
const bs58decode = typeof bs58mod.decode === 'function' ? bs58mod.decode : bs58mod.default.decode;

const raw = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/memory/frankie_wallet.json'));
const kp = raw.secret_b58
  ? Keypair.fromSecretKey(bs58decode(raw.secret_b58))
  : Keypair.fromSecretKey(Uint8Array.from(Array.isArray(raw) ? raw : Object.values(raw)));

console.log('Operator wallet:', kp.publicKey.toBase58());

const connection = new Connection('http://104.250.159.138:8899', 'confirmed');
const sdk = new AgentClient({ rpcUrl: 'http://104.250.159.138:8899', wallet: kp });

const CID = 'QmYHBB4RJVotUkrYYJrr6jS5hN3h9fmiEfGvyWfjHMgTyE';

console.log('Registering FngrVsErrrbody as validator pinning node...');
try {
  const tx = await sdk.register(kp, 'FngrVsErrrbody', CID, CID);
  console.log('✅ Registered! TX:', tx.sig || tx);
} catch(e) {
  console.error('❌ Failed:', e.message);
}
