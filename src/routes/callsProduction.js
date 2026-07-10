const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { addJob, queueNames } = require('../infra/queues');

const router = express.Router();
router.use(requireAuth);

function turnConfig() {
  if (!process.env.TURN_URL) return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], production: false };
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL },
    ],
    production: true,
  };
}

router.get('/turn-config', (req, res) => res.json(turnConfig()));

router.post('/group-call', async (req, res) => {
  const { groupId, title } = req.body || {};
  const call = { id: `call_${Date.now()}`, groupId, title: title || 'Групповой звонок', createdBy: req.userId, status: 'created', turn: turnConfig() };
  await addJob(queueNames.push, 'group-call-created', { userId: req.userId, title: 'Групповой звонок создан', body: call.title, data: call });
  res.status(201).json({ call });
});

router.post('/broadcast', async (req, res) => {
  const { channelId, title } = req.body || {};
  const broadcast = { id: `broadcast_${Date.now()}`, channelId, title: title || 'Прямой эфир', createdBy: req.userId, status: 'created', turn: turnConfig() };
  res.status(201).json({ broadcast });
});

router.post('/quality', (req, res) => {
  const { callId, stats } = req.body || {};
  res.json({ ok: true, callId, quality: { ...(stats || {}), receivedAt: new Date().toISOString() } });
});

router.post('/recording/request', (req, res) => {
  res.json({ ok: true, status: 'requested', note: 'Для production записи подключите media server/SFU. Endpoint сохраняет намерение и готов для интеграции.' });
});

module.exports = router;
