import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const DATA_DIR = path.resolve("./storage");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.resolve("./uploads");
const ARCHIVES_DIR = path.resolve("./archives");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ 
    clients: {},
    archives: {}
  }, null, 2));
}

/**
 * БАЗОВАЯ ИДЕЯ:
 * - Вся "истинная" БД находится в памяти (dbMem)
 * - При старте один раз читаем файл
 * - Каждый раз при изменении: меняем dbMem + ставим задачу на запись в очередь
 * - Очередь writeQueue гарантирует, что на диск пишем по одной операции
 */

let dbMem = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));

let isWriting = false;
const writeQueue = [];

function scheduleWrite() {
  if (isWriting) return;
  isWriting = true;

  const doWrite = () => {
    const task = writeQueue.shift();
    if (!task) {
      isWriting = false;
      return;
    }

    fs.writeFile(DB_FILE, JSON.stringify(dbMem, null, 2), (err) => {
      if (err) console.error("DB write error:", err);
      task();
      setImmediate(doWrite);
    });
  };

  setImmediate(doWrite);
}

function updateDb(mutator, onDone) {
  mutator(dbMem);
  writeQueue.push(onDone || (() => {}));
  scheduleWrite();
}

function readDb() {
  return dbMem;
}

function toClientKey(name) {
  return String(name || "").trim().toLowerCase();
}

const hostCache = new Map();
function absUrl(req, relative) {
  if (!relative || relative.startsWith("http")) return relative;
  const host = req.get("host");
  let base = hostCache.get(host);
  if (!base) {
    base = `https://${host}`;
    hostCache.set(host, base);
  }
  return base + relative;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🆕 ЗАГРУЗКА АРХИВОВ
// ═══════════════════════════════════════════════════════════════════════════════

const uploadArchive = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, ARCHIVES_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || ".zip");
      cb(null, `${Date.now()}_${nanoid(10)}${ext}`);
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB для архивов
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/zip", "application/x-zip-compressed"];
    const ok = allowed.includes(file.mimetype) || file.originalname?.endsWith(".zip");
    cb(ok ? null : new Error("Only zip files allowed"), ok);
  }
});

const uploadPhotos = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}_${nanoid(10)}${ext}`);
    }
  }),
  limits: {
    fileSize: 200 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    const ok = allowed.includes(file.mimetype);
    cb(ok ? null : new Error("Only jpeg/png/webp allowed"), ok);
  }
});

// Статика с кэшированием
app.use("/files", express.static(UPLOAD_DIR, {
  maxAge: "1d",
  etag: true,
  lastModified: true
}));

app.use("/archives", express.static(ARCHIVES_DIR, {
  maxAge: "1d",
  etag: true,
  lastModified: true
}));

// healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════════════════════════════════════
// КЛИЕНТЫ
// ═══════════════════════════════════════════════════════════════════════════════

// Создать/найти клиента
app.post("/api/clients/ensure", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  const key = toClientKey(name);
  const db = readDb();

  if (db.clients[key]) {
    return res.json({ client: db.clients[key], clientKey: key });
  }

  updateDb((db) => {
    if (!db.clients[key]) {
      db.clients[key] = { 
        id: nanoid(10), 
        name, 
        photos: [],
        archives: []
      };
    }
  }, () => {
    const dbAfter = readDb();
    res.json({ client: dbAfter.clients[key], clientKey: key });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ФОТО
// ═══════════════════════════════════════════════════════════════════════════════

// Загрузить фото (до 3 на клиента)
// Загрузить фото (до 3 на клиента)
app.post("/api/clients/:clientKey/photos", uploadPhotos.array("photos", 3), (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) {
    const files = req.files || [];
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.status(404).json({ error: "client not found" });
  }

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "no files uploaded" });

  if (client.photos.length + files.length > 3) {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.status(400).json({ error: "max 3 photos per client" });
  }


  const now = new Date().toISOString();
  const addedLocal = [];

  updateDb((db) => {
    const c = db.clients[clientKey];
    if (!c) return;

    for (const f of files) {
      const photo = {
        id: nanoid(10),
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        url: `/files/${f.filename}`,
        createdAt: now
      };
      c.photos.push(photo);
      addedLocal.push(photo);
    }
  }, () => {
    const dbAfter = readDb();
    const c = dbAfter.clients[clientKey];
    res.json({
      client: { id: c.id, name: c.name },
      added: addedLocal.map(p => ({ ...p, url: absUrl(req, p.url) }))
    });
  });
});

// Получить фото клиента
app.get("/api/clients/:clientKey/photos", (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) return res.status(404).json({ error: "client not found" });

  const photos = client.photos.map(p => ({ ...p, url: absUrl(req, p.url) }));

  res.json({
    client: { id: client.id, name: client.name },
    photos
  });
});

// Удалить фото
app.delete("/api/clients/:clientKey/photos/:photoId", (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const photoId = String(req.params.photoId || "");

  const db = readDb();
  const client = db.clients[clientKey];
  if (!client) return res.status(404).json({ error: "client not found" });

  let removedPhoto = null;

  updateDb((db) => {
    const c = db.clients[clientKey];
    if (!c) return;
    const idx = c.photos.findIndex(p => p.id === photoId);
    if (idx === -1) return;
    [removedPhoto] = c.photos.splice(idx, 1);
  }, () => {
    if (!removedPhoto) {
      return res.status(404).json({ error: "photo not found" });
    }

    setImmediate(() => {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, removedPhoto.filename));
      } catch {}
    });

    res.json({ ok: true, removedId: photoId });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ✅ ЗАМЕНА ФОТО (НОВОЕ) - Удалить все старые фото и загрузить новые
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Заменить все фото клиента новыми (очистить старые)
 * POST /api/clients/:clientKey/photos/replace
 */
app.post("/api/clients/:clientKey/photos/replace", uploadPhotos.array("photos", 3), (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) {
    const files = req.files || [];
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.status(404).json({ error: "client not found" });
  }

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "no files uploaded" });

  if (files.length > 3) {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.status(400).json({ error: "max 3 photos per replace" });
  }

  const now = new Date().toISOString();
  const oldPhotos = [...(client.photos || [])];
  const addedLocal = [];

  updateDb((db) => {
    const c = db.clients[clientKey];
    if (!c) return;

    // 🗑️ Удаляем все старые фото из БД
    c.photos = [];

    // ➕ Добавляем новые фото
    for (const f of files) {
      const photo = {
        id: nanoid(10),
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        url: `/files/${f.filename}`,
        createdAt: now
      };
      c.photos.push(photo);
      addedLocal.push(photo);
    }
  }, () => {
    // 🗑️ Асинхронно удаляем старые файлы с диска
    setImmediate(() => {
      for (const photo of oldPhotos) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
          console.log(`📸 Удалено старое фото: ${photo.filename}`);
        } catch (e) {
          console.warn(`⚠️ Не удалось удалить ${photo.filename}: ${e.message}`);
        }
      }
    });

    const dbAfter = readDb();
    const c = dbAfter.clients[clientKey];
    res.json({
      success: true,
      client: { id: c.id, name: c.name },
      replaced: oldPhotos.length,
      added: addedLocal.map(p => ({ ...p, url: absUrl(req, p.url) }))
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🆕 АРХИВЫ С ВРЕМЕННЫМИ ССЫЛКАМИ
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Загрузить архив и создать временную ссылку (24 часа)
 * POST /api/clients/:clientKey/archive
 */
app.post("/api/clients/:clientKey/archive", uploadArchive.single("archive"), (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) {
    const file = req.file;
    if (file) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    return res.status(404).json({ error: "client not found" });
  }

  const file = req.file;
  if (!file) return res.status(400).json({ error: "no file uploaded" });

  // Генерируем токен для скачивания (24 часа)
  const downloadToken = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 часа

  const archive = {
    id: nanoid(10),
    filename: file.filename,
    originalName: file.originalname,
    size: file.size,
    downloadToken,
    downloadUrl: `/archive/download/${downloadToken}`,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    downloads: 0,
    maxDownloads: null // неограниченно
  };

  let addedArchive = null;

  updateDb((db) => {
    if (!db.archives) db.archives = {};
    
    // Инициализируем массив архивов, если не существует
    if (!db.clients[clientKey].archives) {
      db.clients[clientKey].archives = [];
    }

    // Сохраняем архив в БД
    db.clients[clientKey].archives.push(archive);
    db.archives[downloadToken] = {
      clientKey,
      ...archive
    };

    addedArchive = archive;
  }, () => {
    res.json({
      success: true,
      archive: {
        id: addedArchive.id,
        originalName: addedArchive.originalName,
        size: addedArchive.size,
        downloadUrl: absUrl(req, addedArchive.downloadUrl),
        expiresAt: addedArchive.expiresAt,
        createdAt: addedArchive.createdAt
      },
      message: "Архив загружен. Ссылка действительна 24 часа"
    });
  });
});

/**
 * Скачать архив по токену
 * GET /archive/download/:token
 */
app.get("/archive/download/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token || token.length < 20) {
    return res.status(400).json({ error: "invalid token" });
  }

  const db = readDb();
  const archiveData = db.archives?.[token];

  if (!archiveData) {
    return res.status(404).json({ error: "archive not found or token invalid" });
  }

  // Проверяем срок действия
  const now = new Date();
  const expiresAt = new Date(archiveData.expiresAt);

  if (now > expiresAt) {
    return res.status(410).json({ 
      error: "link expired", 
      expiresAt: archiveData.expiresAt 
    });
  }

  // Проверяем файл на диске
  const filePath = path.join(ARCHIVES_DIR, archiveData.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "file not found on server" });
  }

  // Увеличиваем счётчик скачиваний
  updateDb((db) => {
    if (db.archives[token]) {
      db.archives[token].downloads = (db.archives[token].downloads || 0) + 1;
    }
  });

  // Отправляем файл
  res.download(filePath, archiveData.originalName, (err) => {
    if (err) {
      console.error("Download error:", err);
    }
  });
});

/**
 * Получить информацию об архиве (без скачивания)
 * GET /api/archive/:token/info
 */
app.get("/api/archive/:token/info", (req, res) => {
  const token = String(req.params.token || "").trim();
  const db = readDb();
  const archiveData = db.archives?.[token];

  if (!archiveData) {
    return res.status(404).json({ error: "archive not found" });
  }

  const now = new Date();
  const expiresAt = new Date(archiveData.expiresAt);
  const isExpired = now > expiresAt;
  const timeLeft = Math.max(0, Math.floor((expiresAt - now) / 1000)); // секунды

  res.json({
    id: archiveData.id,
    name: archiveData.originalName,
    size: archiveData.size,
    createdAt: archiveData.createdAt,
    expiresAt: archiveData.expiresAt,
    isExpired,
    timeLeftSeconds: timeLeft,
    downloads: archiveData.downloads,
    downloadUrl: absUrl(req, `/archive/download/${token}`)
  });
});

/**
 * Получить все архивы клиента
 * GET /api/clients/:clientKey/archives
 */
app.get("/api/clients/:clientKey/archives", (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) return res.status(404).json({ error: "client not found" });

  const now = new Date();
  const archives = (client.archives || []).map(archive => {
    const expiresAt = new Date(archive.expiresAt);
    const isExpired = now > expiresAt;
    const timeLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));

    return {
      id: archive.id,
      name: archive.originalName,
      size: archive.size,
      createdAt: archive.createdAt,
      expiresAt: archive.expiresAt,
      isExpired,
      timeLeftSeconds: timeLeft,
      downloads: archive.downloads,
      downloadUrl: absUrl(req, archive.downloadUrl)
    };
  });

  res.json({
    client: { id: client.id, name: client.name },
    archives,
    total: archives.length
  });
});

/**
 * Удалить архив
 * DELETE /api/clients/:clientKey/archive/:archiveId
 */
app.delete("/api/clients/:clientKey/archive/:archiveId", (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const archiveId = String(req.params.archiveId || "");

  const db = readDb();
  const client = db.clients[clientKey];
  if (!client) return res.status(404).json({ error: "client not found" });

  let removedArchive = null;
  let downloadToken = null;

  updateDb((db) => {
    const c = db.clients[clientKey];
    if (!c || !c.archives) return;

    const idx = c.archives.findIndex(a => a.id === archiveId);
    if (idx === -1) return;

    [removedArchive] = c.archives.splice(idx, 1);
    downloadToken = removedArchive.downloadToken;

    // Удаляем из индекса по токенам
    if (db.archives && downloadToken) {
      delete db.archives[downloadToken];
    }
  }, () => {
    if (!removedArchive) {
      return res.status(404).json({ error: "archive not found" });
    }

    // Удаляем файл асинхронно
    setImmediate(() => {
      try {
        fs.unlinkSync(path.join(ARCHIVES_DIR, removedArchive.filename));
      } catch {}
    });

    res.json({ 
      ok: true, 
      removedId: archiveId,
      message: "Archive deleted"
    });
  });
});

/**
 * Получить список всех клиентов
 */
app.get("/api/clients", (req, res) => {
  const db = readDb();
  const clients = Object.entries(db.clients || {}).map(([key, client]) => ({
    key,
    id: client.id,
    name: client.name,
    photoCount: (client.photos || []).length,
    archiveCount: (client.archives || []).length
  }));
  res.json({ clients });
});

/**
 * Удалить клиента (и все его фото и архивы)
 */
app.delete("/api/clients/:clientKey", (req, res) => {
  const clientKey = String(req.params.clientKey || "").toLowerCase();
  const db = readDb();

  const client = db.clients[clientKey];
  if (!client) return res.status(404).json({ error: "client not found" });

  const photosToDelete = [...(client.photos || [])];
  const archivesToDelete = [...(client.archives || [])];
  const clientName = client.name;

  updateDb((db) => {
    // Удаляем токены архивов из индекса
    for (const archive of archivesToDelete) {
      if (db.archives && archive.downloadToken) {
        delete db.archives[archive.downloadToken];
      }
    }
    delete db.clients[clientKey];
  }, () => {
    setImmediate(() => {
      for (const photo of photosToDelete) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, photo.filename));
        } catch {}
      }
      for (const archive of archivesToDelete) {
        try {
          fs.unlinkSync(path.join(ARCHIVES_DIR, archive.filename));
        } catch {}
      }
    });

    res.json({ ok: true, deletedClient: clientName });
  });
});

// Обработчик ошибок
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    const limit = err.field === "archive" ? "100MB" : "200KB";
    return res.status(413).json({ error: `file too large (max ${limit})` });
  }
  return res.status(400).json({ error: err?.message || "bad request" });
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Photo Service listening on http://${HOST}:${PORT}`);
});
