# NYX Server Full Backend Patch

Патч расширяет сервер из архива `12312323qwe-main.zip` до полноценной backend-основы для Telegram-like функций Nyx.

## Главное добавлено

### Каналы
- Публичные/приватные каналы, username, описание, фото, настройки.
- Подписки, инвайты, заявки на вступление.
- Администраторы и права админов.
- Бан/удаление подписчиков.
- Посты канала, редактирование, удаление, отложенные публикации.
- Просмотры постов, реакции, комментарии, закрепы.
- Статистика канала и журнал действий.
- Защита контента через флаг `protected_content`.

### Боты
- Создание ботов владельцем.
- Генерация и ротация токена.
- Команды бота.
- Webhook URL / secret.
- Inline/callback/webhook каркас.
- Bot API style endpoints: `/bots/api/:token/sendMessage`, `/getUpdates`, `/setWebhook`, `/getMe`.
- Права бота в группах.
- Виртуальный Nyx Support бот.

### Группы / супергруппы
- Серверные группы.
- Участники, админы, владелец.
- Настройки группы: тип, slow mode, approval, protected content, permissions JSON.
- Темы/топики.
- Баны, закрепы, журнал действий.
- Поиск участников.
- Инвайт-ссылки.

### Медиа
- Общая media library через `/media-api`.
- Загрузка файлов с сохранением метаданных.
- Link preview cache.
- Метаданные для encrypted media.

### Поиск
- `/search/global` по пользователям, каналам, группам, ботам.
- `/search/messages` по своим личным сообщениям.

### Уведомления
- Push token storage.
- Настройки уведомлений на global/chat/group/channel.

### Синхронизация
- `/sync/state`
- `/sync/full`
- cloud settings key/value.

### Приватность
- Privacy settings.
- Secret chats metadata.
- Key verification placeholder.
- Encrypted media metadata.

### Premium / Stories
- Premium products and purchases.
- Stories, views, reactions.

## Socket.io
- Личные сообщения сохранены.
- Channel events расширены.
- Call signaling сохранён.
- Bot update emit добавлен.

## Проверка
- `node --check` пройден для всех JS-файлов.
- Полный запуск БД в этой среде не проверялся из-за невозможности собрать native binding `better-sqlite3` без доступа к node headers. На обычной машине/VPS после `npm install` это должно собираться стандартно.

## Важно
Это backend-основа, а не промышленный кластер уровня Telegram. Для продакшна ещё нужны:
- PostgreSQL вместо SQLite;
- S3/MinIO для файлов;
- Redis для очередей и socket scale;
- TURN/coturn для стабильных звонков;
- FCM/APNs/Expo push delivery workers;
- полноценные миграции;
- rate limits и антиспам;
- нормальный full-text search;
- encrypted blob storage для E2E медиа.
