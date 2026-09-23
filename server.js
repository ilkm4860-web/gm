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

/*
 * HTML ve resimler GitHub ana dizininde olduğu için
 * public klasörü yerine proje klasörünü kullanıyoruz.
 */
const PUBLIC_DIR = __dirname;

const TOKENS_DIR =
  process.env.TOKENS_DIR || path.join(__dirname, 'data');

const TOKENS_FILE =
  path.join(TOKENS_DIR, 'tokens.json');

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';

const SESSION_SECRET =
  process.env.SESSION_SECRET || 'CHANGE-ME-SESSION-SECRET';

app.set('trust proxy', 1);

app.use(express.json({
  limit: '100kb'
}));

app.use(express.urlencoded({
  extended: true
}));

/*
 * Root dizindeki web dosyalarını servis et.
 * Ancak hassas dosyaları dışarıya açma.
 */
app.use((req, res, next) => {
  const requestedPath = decodeURIComponent(
    req.path || '/'
  );

  const blockedFiles = [
    '/server.js',
    '/server-fixed.js',
    '/package.json',
    '/package-lock.json',
    '/tokens.json',
    '/.env',
    '/.gitignore'
  ];

  if (blockedFiles.includes(requestedPath)) {
    return res.status(404).send('Not Found');
  }

  next();
});

app.use(express.static(PUBLIC_DIR, {
  index: false
}));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

/*
 * Token klasörünü oluştur
 */
fs.mkdirSync(TOKENS_DIR, {
  recursive: true
});

if (!fs.existsSync(TOKENS_FILE)) {
  fs.writeFileSync(
    TOKENS_FILE,
    '[]',
    'utf8'
  );
}

/*
 * Token işlemleri
 */
function readTokens() {
  try {
    return JSON.parse(
      fs.readFileSync(
        TOKENS_FILE,
        'utf8'
      ) || '[]'
    );
  } catch (e) {
    return [];
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(
    TOKENS_FILE,
    JSON.stringify(tokens, null, 2),
    'utf8'
  );
}

/*
 * Local IP
 */
function localIP() {
  for (
    const list of Object.values(
      os.networkInterfaces()
    )
  ) {
    for (const n of (list || [])) {
      if (
        n.family === 'IPv4' &&
        !n.internal
      ) {
        return n.address;
      }
    }
  }

  return '127.0.0.1';
}

/*
 * Public URL
 *
 * Render'da PUBLIC_BASE_URL varsa onu kullanır.
 * Yoksa lokal IP'ye düşer.
 */
function publicBase() {
  return (
    PUBLIC_BASE_URL ||
    `http://${localIP()}:${PORT}`
  );
}

/*
 * Admin kontrolü
 */
function requireAdmin(req, res, next) {
  if (req.session.adminAuthenticated) {
    return next();
  }

  res.redirect('/admin-login');
}

/*
 * HEALTH
 */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'gorkem-makine',
    server: true,
    time: new Date().toISOString()
  });
});

/*
 * ANA SAYFA
 */
app.get('/', (req, res) => {
  if (req.session.authenticated) {
    return res.sendFile(
      path.join(PUBLIC_DIR, 'index.html')
    );
  }

  res.redirect('/access.html');
});

/*
 * ACCESS SAYFASI
 */
app.get('/access.html', (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, 'access.html')
  );
});

/*
 * ADMIN LOGIN
 */
app.get('/admin-login', (req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      'admin-login.html'
    )
  );
});

/*
 * ADMIN LOGIN POST
 */
app.post('/admin-login', (req, res) => {
  const password = String(
    req.body?.password || ''
  );

  if (
    ADMIN_PASSWORD &&
    password === ADMIN_PASSWORD
  ) {
    req.session.adminAuthenticated = true;

    return res.redirect(
      '/admin-panel'
    );
  }

  res.redirect(
    '/admin-login?error=1'
  );
});

/*
 * ADMIN LOGOUT
 */
app.get('/admin-logout', (req, res) => {
  req.session.adminAuthenticated = false;

  res.redirect('/admin-login');
});

/*
 * ADMIN PANEL
 */
app.get(
  '/admin-panel',
  requireAdmin,
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        'admin.html'
      )
    );
  }
);

/*
 * TOKENLARI GETİR
 */
app.get(
  '/api/tokens',
  requireAdmin,
  (req, res) => {
    res.json(readTokens());
  }
);

/*
 * QR OLUŞTUR
 */
app.post(
  '/api/generate-qr',
  requireAdmin,
  async (req, res, next) => {
    try {
      const durationMins =
        Number(
          req.body?.durationMins
        );

      const singleUse =
        Boolean(
          req.body?.singleUse
        );

      if (
        !Number.isFinite(
          durationMins
        ) ||
        durationMins < 1 ||
        durationMins > 10080
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Geçerlilik süresi 1 ile 10080 dakika arasında olmalıdır.'
        });
      }

      const token =
        crypto
          .randomBytes(24)
          .toString('hex');

      const createdAt =
        Date.now();

      const expiresAt =
        createdAt +
        durationMins *
        60 *
        1000;

      const tokenData = {
        token,
        createdAt,
        expiresAt,
        singleUse,
        used: false,
        active: true
      };

      const tokens =
        readTokens();

      tokens.push(tokenData);

      writeTokens(tokens);

      /*
       * ÖNEMLİ:
       * Render'da artık:
       * https://gorkem-makine.onrender.com
       * kullanılacak.
       */
      const accessUrl =
        `${publicBase()}/access/${token}`;

      const qrImage =
        await qrcode.toDataURL(
          accessUrl,
          {
            width: 460,
            margin: 2,
            color: {
              dark: '#17181B',
              light: '#D4AF37'
            }
          }
        );

      res.json({
        success: true,
        qrImage,
        accessUrl,
        tokenData
      });

    } catch (e) {
      next(e);
    }
  }
);

/*
 * TOKEN İPTAL
 */
app.post(
  '/api/revoke-token',
  requireAdmin,
  (req, res) => {

    const token =
      String(
        req.body?.token || ''
      ).trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        message:
          'Token belirtilmedi.'
      });
    }

    const tokens =
      readTokens();

    const index =
      tokens.findIndex(
        t => t.token === token
      );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message:
          'Token bulunamadı.'
      });
    }

    tokens[index].active = false;

    writeTokens(tokens);

    res.json({
      success: true
    });
  }
);

/*
 * QR TOKEN ERİŞİMİ
 *
 * Örnek:
 * /access/abc123
 */
app.get(
  '/access/:token',
  (req, res) => {

    const token =
      String(
        req.params.token || ''
      );

    const tokens =
      readTokens();

    const index =
      tokens.findIndex(
        t =>
          t.token === token &&
          t.active
      );

    if (index === -1) {
      return res.redirect(
        '/access.html?error=invalid'
      );
    }

    const tokenData =
      tokens[index];

    /*
     * Süresi dolmuş mu?
     */
    if (
      Date.now() >
      Number(
        tokenData.expiresAt
      )
    ) {
      return res.redirect(
        '/access.html?error=expired'
      );
    }

    /*
     * Tek kullanımlık token kullanılmış mı?
     */
    if (tokenData.used) {
      return res.redirect(
        '/access.html?error=used'
      );
    }

    /*
     * Single use ise kullanıldı olarak işaretle.
     */
    if (tokenData.singleUse) {
      tokenData.used = true;

      writeTokens(tokens);
    }

    /*
     * Kullanıcıya erişim ver.
     */
    req.session.authenticated = true;

    res.redirect(
      '/?granted=true'
    );
  }
);

/*
 * NORMAL LOGOUT
 */
app.get(
  '/logout',
  (req, res) => {
    req.session.destroy(() => {
      res.redirect(
        '/access.html'
      );
    });
  }
);

/*
 * Bilinmeyen API
 */
app.use(
  '/api',
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        `API endpoint bulunamadı: ${req.method} ${req.originalUrl}`
    });
  }
);

/*
 * HATA YAKALAMA
 */
app.use(
  (err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      success: false,
      message:
        'Sunucu tarafında hata oluştu.'
    });
  }
);

/*
 * SERVER
 */
app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Görkem Makine running on ${HOST}:${PORT}`
    );

    console.log(
      `Public base: ${publicBase()}`
    );
  }
);
