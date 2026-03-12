/**
 * AXON Protocol — Real TinyLlama Inference
 *
 * Runs TinyLlama-1.1B-Chat-v1.0-Q4_K_M via llama.cpp subprocess.
 * The inference hash is SHA256d of the raw token output text,
 * making it deterministic for any given (model, challenge) pair.
 *
 * Canonical model: TinyLlama-1.1B-Chat-v1.0-Q4_K_M
 * Model SHA256:    pinned in genesis block constants
 */

import { execFile }  from 'child_process';
import * as path     from 'path';
import * as fs       from 'fs';
import * as crypto   from 'crypto';
import { sha256d }   from '../blockchain/crypto';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const LLAMA_CLI  = process.env.LLAMA_CLI  || '/usr/local/bin/llama-cli';
const MODEL_PATH = process.env.AXON_MODEL || path.join(process.env.HOME || '.', '.axon', 'models', 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf');

// Inference params — fixed for determinism
const N_TOKENS  = 64;    // exactly 64 tokens per inference
const TEMP      = 0.0;   // greedy decoding — fully deterministic
const SEED      = 42;    // fixed seed for reproducibility
const CTX_SIZE  = 512;

// ─── MODEL AVAILABILITY ──────────────────────────────────────────────────────

export function isInferenceReady(): boolean {
  return fs.existsSync(LLAMA_CLI) && fs.existsSync(MODEL_PATH);
}

export function getInferenceStatus(): {
  ready:      boolean;
  llamaCli:   string;
  modelPath:  string;
  llamaExists: boolean;
  modelExists: boolean;
} {
  return {
    ready:       isInferenceReady(),
    llamaCli:    LLAMA_CLI,
    modelPath:   MODEL_PATH,
    llamaExists: fs.existsSync(LLAMA_CLI),
    modelExists: fs.existsSync(MODEL_PATH),
  };
}

// ─── REAL INFERENCE ──────────────────────────────────────────────────────────

/**
 * Run TinyLlama on a challenge string.
 * Returns SHA256d of the raw output text.
 *
 * The prompt is deliberately minimal — we want the model's raw
 * token distribution, not a chat response. The challenge hex
 * string is fed as the entire prompt. Output is deterministic
 * because temp=0 (greedy) and seed is fixed.
 */
export async function runRealInference(challenge: string): Promise<string> {
  if (!isInferenceReady()) {
    throw new Error(
      `Inference not ready.\n` +
      `  llama-cli: ${LLAMA_CLI} (${fs.existsSync(LLAMA_CLI) ? 'OK' : 'MISSING'})\n` +
      `  model:     ${MODEL_PATH} (${fs.existsSync(MODEL_PATH) ? 'OK' : 'MISSING'})\n` +
      `  Run: axon setup-inference`
    );
  }

  const prompt = `AXON:${challenge}`;

  return new Promise((resolve, reject) => {
    const args = [
      '--model',       MODEL_PATH,
      '--prompt',      prompt,
      '--n-predict',   String(N_TOKENS),
      '--temp',        String(TEMP),
      '--seed',        String(SEED),
      '--ctx-size',    String(CTX_SIZE),
      '--no-warmup',
      '--log-disable',
      '--single-turn', // exit after one turn (non-interactive with --prompt)
    ];

    execFile(LLAMA_CLI, args, {
      timeout: 180_000, // 3 min max — CPU inference is slow
      maxBuffer: 256 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`llama-cli failed: ${err.message}\n${stderr.slice(0, 400)}`));
      }

      // llama-cli b1-0516e04 outputs in this format:
      //   <banner/loading lines>
      //   > AXON:<challenge>
      //   <blank line>
      //   <generated text>
      //   <blank line>
      //   [ Prompt: ... | Generation: ... t/s ]
      //   Exiting...
      //
      // We extract everything between the prompt echo line and the timing line.
      const lines = stdout.split('\n');
      const promptMarker = `> ${prompt}`;
      const promptIdx = lines.findIndex(l => l.includes(promptMarker));
      const timingIdx = lines.findIndex(l => l.startsWith('[ Prompt:'));

      let raw: string;
      if (promptIdx !== -1) {
        const start = promptIdx + 1;
        const end   = timingIdx !== -1 ? timingIdx : lines.length;
        raw = lines.slice(start, end).join('\n');
      } else {
        // Fallback: take everything after the last double-newline before generation
        raw = stdout.replace(/[\s\S]*?\n\n(?=\S)/, '');
      }

      // Strip backspace sequences (spinner animation: char + \b + char + \b + space + \b)
      // and any remaining ANSI/control chars, then trim
      raw = raw
        .replace(/.\x08/g, '')           // remove char+backspace pairs
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // remove other control chars (keep \n = 0x0a)
        .trim();

      const hash = sha256d(Buffer.from(raw, 'utf8')).toString('hex');
      resolve(hash);
    });
  });
}

// ─── BENCHMARK ───────────────────────────────────────────────────────────────

export async function benchmarkInference(): Promise<{
  tokensPerSecond: number;
  inferenceMs:     number;
  outputLength:    number;
  hash:            string;
}> {
  const challenge = crypto.randomBytes(32).toString('hex');
  const start     = Date.now();
  const hash      = await runRealInference(challenge);
  const ms        = Date.now() - start;
  return {
    tokensPerSecond: Math.round(N_TOKENS / (ms / 1000)),
    inferenceMs:     ms,
    outputLength:    N_TOKENS,
    hash,
  };
}

// ─── MODEL HASH VERIFICATION ─────────────────────────────────────────────────

/**
 * Compute SHA256 of the model file.
 * This must match the value pinned in genesis block.
 */
export async function computeModelHash(): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(MODEL_PATH);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end',  ()    => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
