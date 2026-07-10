// src/index.js
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { httpLogger, logger } = require('./infra/logger');
const { applySecurity } = require('./infra/security');
const { applySocketScaling } = require('./infra/socketScale');
const { applyPerformance, staticCacheOptions } = require('./infra/performance');
const { setupGracefulShutdown } = require('./infra/shutdown');
const { scheduleSqliteMaintenance } = require('./infra/sqliteMaintenance');
const { notFound, errorHandler } = require('./middleware/errors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');
const marketplaceRoutes = require('./routes/marketplace');
const reactionRoutes = require('./routes/reactions');
const businessRoutes = require('./routes/business');
const deviceRoutes = require('./routes/devices');
const groupRoutes = require('./routes/groups');
const botRoutes = require('./routes/bots');
const mediaRoutes = require('./routes/media');
const searchRoutes = require('./routes/search');
const notificationRoutes = require('./routes/notifications');
const syncRoutes = require('./routes/sync');
const privacyRoutes = require('./routes/privacy');
const premiumRoutes = require('./routes/premium');
const storyRoutes = require('./routes/stories');
const productionRoutes = require('./routes/production');
const filesV2Routes = require('./routes/filesV2');
const stickerStudioRoutes = require('./routes/stickerStudio');
const callsProductionRoutes = require('./routes/callsProduction');
const botFatherAdvancedRoutes = require('./routes/botFatherAdvanced');
const { attachSockets } = require('./sockets');

const app = express();
applyPerformance(app);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(httpLogger());
applySecurity(app);
app.use(express.json({ limit: process.env.JSON_LIMIT || '2mb' }));

// Статика для аватаров и медиа-вложений чатов (см. оговорку про отсутствие
// E2E-шифрования файлов в routes/messages.js и routes/users.js).
app.use('/avatars', express.static(path.join(__dirname, '..', 'data', 'avatars'), staticCacheOptions()));
app.use('/media', express.static(path.join(__dirname, '..', 'data', 'media'), staticCacheOptions()));
app.use('/media-v2', express.static(path.join(__dirname, '..', 'data', 'media-v2'), staticCacheOptions()));

app.get('/health', (req, res) => res.json({ ok: true, service: 'nyx-server' }));

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/messages', messageRoutes);
app.use('/channels', channelRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/reactions', reactionRoutes);
app.use('/business', businessRoutes);
app.use('/devices', deviceRoutes);
app.use('/api/groups', groupRoutes);
app.use('/groups', groupRoutes);
app.use('/bots', botRoutes);
app.use('/media-api', mediaRoutes);
app.use('/search', searchRoutes);
app.use('/notifications', notificationRoutes);
app.use('/sync', syncRoutes);
app.use('/privacy', privacyRoutes);
app.use('/premium', premiumRoutes);
app.use('/stories', storyRoutes);
app.use('/production', productionRoutes);
app.use('/files-v2', filesV2Routes);
app.use('/sticker-studio', stickerStudioRoutes);
app.use('/calls-production', callsProductionRoutes);
app.use('/botfather', botFatherAdvancedRoutes);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const io = new Server(server, {
  cors: { origin: '*' }, // сузьте до домена клиента в проде
});

app.set('io', io);
applySocketScaling(io);

attachSockets(io);
scheduleSqliteMaintenance();
setupGracefulShutdown(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Nyx server слушает порт ${PORT}`);
});
