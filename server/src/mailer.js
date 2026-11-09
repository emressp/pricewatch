import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function slug(value) {
  return String(value || 'alert').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'alert';
}

export function createMailer(config, db = null) {
  let transportPromise = null;

  async function smtpTransport() {
    if (!config.smtp.host) return null;
    if (!transportPromise) {
      transportPromise = import('nodemailer').then((mod) => {
        const nodemailer = mod.default || mod;
        const startTls = !config.smtp.secure && Number(config.smtp.port) === 587;
        return nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          requireTLS: startTls,
          auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        });
      });
    }
    return transportPromise;
  }

  return {
    async send({ to, subject, text }) {
      const at = new Date().toISOString();
      if (config.mailOutbox) {
        await mkdir(config.outboxDir, { recursive: true });
        const file = path.join(config.outboxDir, `${Date.now()}-${slug(subject)}.txt`);
        await writeFile(file, `To: ${to}\nSubject: ${subject}\nDate: ${at}\n\n${text}\n`);
      }
      if (config.logMail) {
        console.log(`\n[pricewatch mail] to=${to} subject=${subject}\n${text}\n`);
      }
      if (config.smtp.host) {
        const limit = Number(config.mailDailyLimit || 450);
        if (db?.reserveMailSend && !await db.reserveMailSend(limit)) {
          console.log(`[pricewatch mail] daily limit ${limit} reached; skipped to=${to} subject=${subject}`);
          return { to, subject, text, at, skipped: true };
        }
        const transport = await smtpTransport();
        await transport.sendMail({ from: config.mailFrom, to, subject, text });
        if (!config.logMail) console.log(`[pricewatch mail] sent to=${to} subject=${subject}`);
      }
      return { to, subject, text, at };
    },
  };
}
