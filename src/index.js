// src/index.js
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');
const marketplaceRoutes = require('./routes/marketplace');
const reactionRoutes = require('./routes/reactions');
const businessRoutes = require('./routes/business');
const deviceRoutes = require('./routes/devices');
const groupRoutes = require('./routes/groups');
const { attachSockets } = require('./sockets');

const app = express();
app.use(cors());
app.use(express.json());

// Статика для аватаров и медиа-вложений чатов (см. оговорку про отсутствие
// E2E-шифрования файлов в routes/messages.js и routes/users.js).
app.use('/avatars', express.static(path.join(__dirname, '..', 'data', 'avatars')));
app.use('/media', express.static(path.join(__dirname, '..', 'data', 'media')));

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

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // сузьте до домена клиента в проде
});

app.set('io', io);

attachSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Nyx server слушает порт ${PORT}`);
});
