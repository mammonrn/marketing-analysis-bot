#!/usr/bin/env node
/**
 * Turn a dashboard PIN into the value for DASHBOARD_PIN_HASH.
 *
 *   node scripts/hash-pin.mjs
 *
 * Reads the PIN from stdin so it never lands in the shell history or in `ps`.
 * The PIN itself is never stored anywhere — only this hash goes into .env.
 *
 *   node scripts/hash-pin.mjs --verify     ตรวจว่า PIN ตรงกับ DASHBOARD_PIN_HASH ที่ตั้งไว้
 */

import readline from 'node:readline';
import 'dotenv/config';

// This script only needs the PIN helpers, but they come through config.js,
// which insists on the bot's own credentials. Placeholders keep it runnable
// from a checkout that has no .env yet.
process.env.TELEGRAM_BOT_TOKEN ||= 'hash-pin-cli';
process.env.ANTHROPIC_API_KEY ||= 'hash-pin-cli';

const { hashPin, verifyPin } = await import('../src/miniapp/pin.js');

// One interface for the whole script: closing and reopening one over stdin
// loses whatever the second prompt was about to read.
const masked = Boolean(process.stdin.isTTY);
let rl;
let currentPrompt = null;
let piped;

async function ask(prompt) {
  // Piped input (`printf '1234\n1234\n' | npm run hash:pin`) is read in one go:
  // when stdin is not a terminal readline emits every buffered line at once, so
  // a prompt registered after the first would never see its line.
  if (!masked) {
    if (!piped) {
      let data = '';
      for await (const part of process.stdin) data += part;
      piped = data.split(/\r?\n/);
    }
    process.stderr.write(`${prompt}\n`);
    return (piped.shift() ?? '').trim();
  }

  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: masked,
    });
    // Echo nothing but the prompt: this is a secret being typed into a
    // terminal someone else may be looking at.
    if (masked) {
      rl._writeToOutput = (chunk) => {
        if (currentPrompt && chunk.includes(currentPrompt)) rl.output.write(chunk);
      };
    }
  }
  currentPrompt = prompt;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      if (masked) rl.output.write('\n');
      resolve(answer.trim());
    });
  });
}

function done(code = 0) {
  rl?.close();
  process.exit(code);
}

const verifyMode = process.argv.includes('--verify');

if (verifyMode) {
  if (!process.env.DASHBOARD_PIN_HASH) {
    console.error('ยังไม่ได้ตั้ง DASHBOARD_PIN_HASH ใน .env — ไม่มีอะไรให้ตรวจ');
    done(1);
  }
  const pin = await ask('PIN ที่จะตรวจ: ');
  console.log(verifyPin(pin) ? '✅ ตรงกับ DASHBOARD_PIN_HASH ที่ตั้งไว้' : '❌ ไม่ตรง');
  done();
}

const pin = await ask('ตั้ง PIN ใหม่: ');
if (!pin) {
  console.error('PIN ว่างไม่ได้');
  done(1);
}
const again = await ask('พิมพ์ PIN อีกครั้ง: ');
if (pin !== again) {
  console.error('PIN สองครั้งไม่ตรงกัน — ยังไม่ได้สร้าง hash');
  done(1);
}
if (pin.length < 4) {
  console.error('PIN สั้นเกินไป — อย่างน้อย 4 ตัว');
  done(1);
}

console.error('\nคัดลอกบรรทัดนี้ไปใส่ .env บน VPS แล้ว pm2 restart ads-analytics-bot:\n');
console.log(`DASHBOARD_PIN_HASH=${hashPin(pin)}`);
console.error('\n(เปลี่ยน PIN เมื่อไหร่ คนที่ปลดล็อกไว้ในเบราว์เซอร์จะต้องกรอกใหม่ทุกคน)');
done();
