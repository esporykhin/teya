# Telegram Userbot Transport

Подключение реального Telegram-аккаунта к Тее через MTProto (GramJS).
Тея может читать и писать сообщения от имени пользователя — без бота, как обычный аккаунт.

---

## Требования

- Node.js 20+
- `api_id` и `api_hash` — получить на https://my.telegram.org/apps
  (создайте приложение, тип "Other", название произвольное)

---

## Установка

В корне монорепо:

```bash
pnpm install
```

---

## Первый запуск (логин)

```bash
teya telegram login
```

Что происходит:

1. Спрашивает номер телефона (формат `+79991234567`).
2. Telegram присылает SMS или код в другой сеанс — введите его.
3. Если включена 2FA — спрашивает пароль.
4. После успешного входа сессия сохраняется в `~/.teya/config.json` (поле `telegramUserbotSession`).

При следующих запусках логин не нужен — сессия подхватывается автоматически.

---

## Запуск агента

```bash
teya --transport telegram-userbot
```

С явными параметрами:

```bash
teya --transport telegram-userbot \
     --telegram-api-id 12345678 \
     --telegram-api-hash abcdef1234567890abcdef1234567890
```

---

## Настройки

| CLI флаг                    | Env переменная           | Описание                                                     |
|-----------------------------|--------------------------|--------------------------------------------------------------|
| `--telegram-api-id`         | `TELEGRAM_API_ID` / `TG_API_ID` | Числовой ID приложения с my.telegram.org             |
| `--telegram-api-hash`       | `TELEGRAM_API_HASH` / `TG_API_HASH` | Hash приложения с my.telegram.org               |
| `--telegram-session`        | `TELEGRAM_SESSION`       | StringSession строка (если не хранить в config.json)         |
| `--telegram-allowed-chats`  | `TELEGRAM_ALLOWED_CHATS` | Whitelist chat ID через запятую (Тея отвечает только в них)  |
| `--telegram-trigger`        | `TELEGRAM_TRIGGER`       | Префикс в исходящих сообщениях для вызова Теи (например `!t `) |

Все параметры также можно сохранить в `~/.teya/config.json` — они подхватываются при каждом запуске.

---

## Режимы работы

Режим определяется комбинацией флагов.

**Только Saved Messages (дефолт, безопасный sandbox)**

Никаких дополнительных настроек. Тея отвечает только на сообщения в вашем Saved Messages (чат с самим собой).

**Whitelist чатов (`--telegram-allowed-chats`)**

```bash
teya --transport telegram-userbot --telegram-allowed-chats "123456789,987654321"
```

Тея автоматически отвечает на входящие сообщения из указанных чатов.
Chat ID можно узнать командой `teya telegram status` или через `core:telegram` → `get_dialogs`.

**Префикс в исходящих (`--telegram-trigger`)**

```bash
teya --transport telegram-userbot --telegram-trigger "!t "
```

Тея обрабатывает ваши исходящие сообщения, начинающиеся с префикса, в любом чате.
Пример: вы пишете `!t напиши вежливый отказ` — Тея отвечает за вас в этом же чате.

Режимы можно комбинировать.

---

## Доступные действия (core:telegram)

Инструмент автоматически регистрируется при запуске с `--transport telegram-userbot`.

| Действие            | Параметры                                                  |
|---------------------|------------------------------------------------------------|
| `send_message`      | `peer`, `text`, `reply_to?`, `silent?`, `parse_mode?`      |
| `send_file`         | `peer`, `path`, `caption?`, `force_document?`, `voice?`    |
| `edit_message`      | `peer`, `message_id`, `text`                               |
| `delete_messages`   | `peer`, `message_ids[]` (макс. 100), `revoke?`             |
| `forward_messages`  | `from_peer`, `to_peer`, `message_ids[]` (макс. 100)        |
| `pin_message`       | `peer`, `message_id`, `unpin?`, `notify?`                  |
| `send_reaction`     | `peer`, `message_id`, `emoji`                              |
| `read_history`      | `peer`, `max_id?`                                          |
| `set_typing`        | `peer`, `action_type?`                                     |
| `get_me`            | —                                                          |
| `resolve_peer`      | `peer`                                                     |
| `get_dialogs`       | `limit?`, `archived?`                                      |
| `get_chat`          | `peer`                                                     |
| `get_messages`      | `peer`, `limit?`, `search?`, `from_user?`, `offset_id?`    |
| `get_participants`  | `peer`, `limit?`, `search?`                                |
| `download_media`    | `peer`, `message_id`, `save_as`                            |
| `join_chat`         | `peer` (username или invite-ссылка)                        |
| `leave_chat`        | `peer`                                                     |
| `create_group`      | `title`, `users[]`                                         |
| `create_channel`    | `title`, `about?`, `broadcast?`, `megagroup?`              |
| `invite_users`      | `peer`, `users[]`                                          |
| `kick_user`         | `peer`, `user`                                             |
| `get_contacts`      | —                                                          |
| `add_contact`       | `phone`, `first_name`, `last_name?`                        |
| `search_contacts`   | `query`, `limit?`                                          |
| `invoke_raw`        | `method`, `params`                                         |

Peer форматы: `"me"` / `"self"` (Saved Messages), `@username`, `+79991234567`, числовой ID.

---

## Диагностика

```bash
# Статус подключения и текущий аккаунт
teya telegram status

# Проверка конфига, сессии и доступности Telegram
teya telegram doctor

# Отправить тестовое сообщение в Saved Messages
teya telegram test
```

Лог входящих/исходящих сообщений пишется в `~/.teya/telegram-userbot.log` (JSONL, ротация при 10 MB).

---

## Безопасность

- Session string — это полный доступ к аккаунту, аналог пароля.
- Хранить только локально в `~/.teya/config.json` (создаётся с правами 600).
- Никогда не коммитить session string в git.
- Никогда не передавать session string третьим лицам.
- Если session string скомпрометирован — завершите все сессии на https://my.telegram.org/auth/logoutall и перезапустите `teya telegram login`.
