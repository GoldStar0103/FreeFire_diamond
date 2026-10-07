/**
 * Sending the OTP code over email.
 *
 * `EmailSender` is the port both implementations satisfy, same pattern as
 * the previous WhatsApp sender and as `Alerter` in the engine package:
 * callers depend on the interface, not on which one is wired up.
 *
 * SMTP is used on purpose — any mailbox the owner already has (Hostinger,
 * Gmail app password, Zoho) works, with no Meta Business / template
 * approval in the way. `ConsoleEmailSender` is the local/CI default so
 * signup can be tested with no credentials at all.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface EmailSender {
  sendOtpCode(to: string, code: string): Promise<void>;
}

/** Local/dev default: prints the code instead of sending it. */
export class ConsoleEmailSender implements EmailSender {
  async sendOtpCode(to: string, code: string): Promise<void> {
    console.log(`[email:dev] OTP for ${to}: ${code}`);
  }
}

export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Immediate TLS (typically port 465). Port 587 uses STARTTLS instead. */
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * The address SMTP actually talks in (`MAIL FROM`, `RCPT TO`).
 * Accepts a bare mailbox or `Name <mailbox@host>` — the form people paste
 * from a mail client's "From" field.
 */
export function smtpEnvelopeAddress(value: string): string {
  const trimmed = value.trim();
  const angled = trimmed.match(/<([^<>]+)>/);
  const extracted = angled?.[1];
  const candidate = (extracted ?? trimmed).trim();
  if (!/^[^<>@\s]+@[^<>@\s]+$/.test(candidate)) {
    throw new EmailSendError(`not a mailbox address: ${trimmed.slice(0, 80)}`);
  }
  return candidate;
}

export function smtpFromHeader(from: string): string {
  if (from.includes('<')) return from.trim();
  return `LevelUp Store <${smtpEnvelopeAddress(from)}>`;
}

export class SmtpEmailSender implements EmailSender {
  constructor(private readonly config: SmtpConfig) {}

  async sendOtpCode(to: string, code: string): Promise<void> {
    const subject = 'Tu código de LevelUp';
    const text =
      `Tu código para entrar a Mi LevelUp es ${code}.\n\n` +
      `Caduca en 10 minutos. Si no lo pediste, ignora este correo.`;
    await sendSmtpMail(this.config, { to, subject, text });
  }
}

/**
 * Built on first use, so a missing config fails at the point something
 * actually wants to send a message — same reasoning as `getProvider()` in
 * server.ts — rather than at build time or on every unrelated page load.
 */
export function buildEmailSender(env = process.env): EmailSender {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  const from = env.SMTP_FROM?.trim() || user;

  if (!host || !user || !pass || !from) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are required in production');
    }
    return new ConsoleEmailSender();
  }

  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE === 'true' || port === 465;

  return new SmtpEmailSender({ host, port, secure, user, pass, from });
}

// ── line-buffered SMTP (AUTH PLAIN + STARTTLS / implicit TLS) ────────────────

class SmtpSession {
  private buffer = '';
  private waiters: Array<(line: string) => void> = [];

  constructor(private socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        const next = this.waiters.shift();
        if (next) next(line);
      }
    });
  }

  attach(socket: Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        const next = this.waiters.shift();
        if (next) next(line);
      }
    });
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EmailSendError('SMTP timed out waiting for a reply')), 20_000);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  /** Read until the last line of a multi-line reply (`250-` … `250 `). */
  async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3}[ -]/.test(line) && line[3] === ' ') {
        return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
      }
      if (!/^\d{3}-/.test(line) && /^\d{3} /.test(line)) {
        return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
      }
    }
  }

  async expect(code: number, verb: string): Promise<void> {
    const reply = await this.readReply();
    if (reply.code !== code) {
      throw new EmailSendError(`SMTP ${verb} failed (${reply.code}): ${reply.text.slice(0, 200)}`);
    }
  }

  async command(line: string, expected: number): Promise<void> {
    this.socket.write(`${line}\r\n`);
    await this.expect(expected, line.split(' ')[0] ?? 'CMD');
  }

  writeRaw(data: string): void {
    this.socket.write(data);
  }
}

async function sendSmtpMail(
  config: SmtpConfig,
  mail: { to: string; subject: string; text: string },
): Promise<void> {
  const raw = await openSocket(config);
  const session = new SmtpSession(raw);
  try {
    await session.expect(220, 'connect');
    await session.command(`EHLO levelupstore.mx`, 250);

    if (!config.secure) {
      await session.command('STARTTLS', 220);
      const tls = await upgradeToTls(raw, config.host);
      session.attach(tls);
      await session.command(`EHLO levelupstore.mx`, 250);
      await authenticateAndSend(session, config, mail);
      return;
    }

    await authenticateAndSend(session, config, mail);
  } finally {
    raw.destroy();
  }
}

async function authenticateAndSend(
  session: SmtpSession,
  config: SmtpConfig,
  mail: { to: string; subject: string; text: string },
): Promise<void> {
  const token = Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64');
  await session.command(`AUTH PLAIN ${token}`, 235);
  const fromAddr = smtpEnvelopeAddress(config.from);
  const toAddr = smtpEnvelopeAddress(mail.to);
  await session.command(`MAIL FROM:<${fromAddr}>`, 250);
  await session.command(`RCPT TO:<${toAddr}>`, 250);
  await session.command('DATA', 354);

  const date = new Date().toUTCString();
  const body =
    `From: ${smtpFromHeader(config.from)}\r\n` +
    `To: <${toAddr}>\r\n` +
    `Subject: ${mail.subject}\r\n` +
    `Date: ${date}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n` +
    `\r\n` +
    `${mail.text.replace(/\n/g, '\r\n')}\r\n` +
    `.\r\n`;
  session.writeRaw(body);
  await session.expect(250, 'DATA');
  await session.command('QUIT', 221).catch(() => undefined);
}

function openSocket(config: SmtpConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(new EmailSendError(`SMTP connect failed: ${err.message}`));
    if (config.secure) {
      const socket = tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => {
        socket.off('error', onError);
        resolve(socket);
      });
      socket.once('error', onError);
      return;
    }
    const socket = netConnect({ host: config.host, port: config.port }, () => {
      socket.off('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function upgradeToTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: host }, () => resolve(tls));
    tls.once('error', (err) => reject(new EmailSendError(`SMTP STARTTLS failed: ${err.message}`)));
  });
}
