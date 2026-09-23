const express = require('express');
const session = require('express-session');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKENS_DIR = path.join(__dirname, 'data');
const TOKENS_FILE = path.join(TOKENS_DIR, 'tokens.json');

// ---------------------------
// Middleware
// ---------------------------
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.static(PUBLIC_DIR));

app.use(session({
  secret: process.env.SESSION_SECRET || 'gorkem-makine-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// ---------------------------
// Storage helpers
// ---------------------------
if (!fs.existsSync(TOKENS_DIR)) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

if (!fs.existsSync(TOKENS_FILE)) {
  fs.writeFileSync(TOKENS_FILE, '[]', 'utf8');
}

function readTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    const tokens = JSON.parse(raw || '[]');
    return Array.isArray(tokens) ? tokens : [];
  } catch (error) {
    console.error('tokens.json okuma hatası:', error);
    return [];
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}

// ---------------------------
// Health check
// ---------------------------
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'gorkem-makine',
    server: true,
    time: new Date().toISOString()
  });
});

// ---------------------------
// Main access control
// ---------------------------
app.get('/', (req, res) => {
  if (req.session.authenticated) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  return res.redirect('/access.html');
});

// ---------------------------
// Admin
// ---------------------------
app.get('/admin-panel', (req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// ---------------------------
// API: Generate QR Token
// ---------------------------
app.post('/api/generate-qr', async (req, res, next) => {
  try {
    const durationMins = Number(req.body?.durationMins);
    const singleUse = Boolean(req.body?.singleUse);

    if (!Number.isFinite(durationMins) || durationMins < 1 || durationMins > 10080) {
      return res.status(400).json({
        success: false,
        message: 'Geçerlilik süresi 1 ile 10080 dakika arasında olmalıdır.'
      });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + durationMins * 60 * 1000;

    const newToken = {
      token,
      createdAt,
      expiresAt,
      singleUse,
      used: false,
      active: true
    };

    const tokens = readTokens();
    tokens.push(newToken);
    writeTokens(tokens);

    const localIP = getLocalIP();
    const accessUrl = `http://${localIP}:${PORT}/access/${token}`;

    const qrImage = await qrcode.toDataURL(accessUrl, {
      width: 460,
      margin: 2,
      color: {
        dark: '#17181B',
        light: '#D4AF37'
      }
    });

    console.log(`QR oluşturuldu: ${accessUrl}`);

    return res.status(200).json({
      success: true,
      qrImage,
      accessUrl,
      tokenData: newToken
    });
  } catch (error) {
    console.error('/api/generate-qr hatası:', error);
    return next(error);
  }
});

// ---------------------------
// API: Get Tokens
// ---------------------------
app.get('/api/tokens', (req, res, next) => {
  try {
    return res.json(readTokens());
  } catch (error) {
    return next(error);
  }
});

// ---------------------------
// API: Revoke Token
// ---------------------------
app.post('/api/revoke-token', (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token belirtilmedi.'
      });
    }

    const tokens = readTokens();
    const index = tokens.findIndex(t => t.token === token);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: 'Token bulunamadı.'
      });
    }

    tokens[index].active = false;
    writeTokens(tokens);

    return res.json({
      success: true,
      message: 'Token iptal edildi.'
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------
// API: Validate Token
// ---------------------------
app.get('/access/:token', (req, res) => {
  const paramToken = String(req.params.token || '');
  const tokens = readTokens();
  const tokenIndex = tokens.findIndex(
    t => t.token === paramToken && t.active === true
  );

  if (tokenIndex === -1) {
    return res.redirect('/access.html?error=invalid');
  }

  const tokenData = tokens[tokenIndex];

  if (Date.now() > Number(tokenData.expiresAt)) {
    return res.redirect('/access.html?error=expired');
  }

  if (tokenData.used) {
    return res.redirect('/access.html?error=used');
  }

  if (tokenData.singleUse) {
    tokenData.used = true;
    writeTokens(tokens);
  }

  req.session.authenticated = true;
  return res.redirect('/?granted=true');
});

// ---------------------------
// Logout
// ---------------------------
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/access.html');
  });
});

// ---------------------------
// JSON 404 for API routes
// ---------------------------
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint bulunamadı: ${req.method} ${req.originalUrl}`
  });
});

// ---------------------------
// Final error handler
// ---------------------------
app.use((err, req, res, next) => {
  console.error('Sunucu hatası:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    message: 'Sunucu tarafında hata oluştu.',
    error: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
});

// ---------------------------
// Start
// ---------------------------
app.listen(PORT, HOST, () => {
  const ip = getLocalIP();

  console.log('\n=========================================');
  console.log(' ⚙️  GÖRKEM MAKİNE LOCAL SYSTEM');
  console.log(' 🔐 QR ACCESS SERVER RUNNING');
  console.log('=========================================');
  console.log(`▶ Bilgisayar: http://localhost:${PORT}`);
  console.log(`▶ Telefon / Yerel Ağ: http://${ip}:${PORT}`);
  console.log(`▶ Admin Paneli: http://${ip}:${PORT}/admin-panel`);
  console.log(`▶ API Health: http://${ip}:${PORT}/api/health`);
  console.log('=========================================\n');
});
