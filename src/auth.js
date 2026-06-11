const crypto = require('node:crypto');
const { parseCookies, randomId } = require('./util');

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored = '') {
  const [scheme, salt, expected] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

class AuthManager {
  constructor(configStore) {
    this.configStore = configStore;
    this.sessions = new Map();
    this.ttlMs = 12 * 60 * 60 * 1000;
  }

  async setup(username, password) {
    if (await this.configStore.hasAdmin()) {
      throw Object.assign(new Error('Admin already exists'), { statusCode: 409 });
    }
    if (!username || !password || String(password).length < 8) {
      throw Object.assign(new Error('Username and password with at least 8 characters are required'), { statusCode: 400 });
    }
    await this.configStore.setAdmin({
      username: String(username).trim(),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    });
  }

  async login(username, password) {
    const admin = await this.configStore.getAdmin();
    if (!admin || admin.username !== username || !verifyPassword(password, admin.passwordHash)) {
      throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
    }
    const token = randomId('sess_');
    this.sessions.set(token, {
      username: admin.username,
      expiresAt: Date.now() + this.ttlMs
    });
    return token;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  cookie(token) {
    return `codex_proxy_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttlMs / 1000)}`;
  }

  clearCookie() {
    return 'codex_proxy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }

  sessionFromReq(req) {
    const token = parseCookies(req.headers.cookie || '').codex_proxy_session;
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return { token, username: session.username };
  }

  async me(req) {
    const hasAdmin = await this.configStore.hasAdmin();
    const session = this.sessionFromReq(req);
    return {
      setupRequired: !hasAdmin,
      authenticated: Boolean(session),
      username: session?.username || ''
    };
  }

  requireAdmin(req) {
    const session = this.sessionFromReq(req);
    if (!session) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
    return session;
  }
}

module.exports = {
  AuthManager,
  hashPassword,
  verifyPassword
};
