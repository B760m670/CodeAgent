# CodeAgent

Бесплатный self-hosted AI-агент для программирования — открытая альтернатива
**Claude Code** и **OpenAI Codex** с веб-интерфейсом и интеграцией с GitHub.

Агент изучает проект, читает и правит файлы, запускает команды и тесты, создаёт
ветки, коммитит, пушит, открывает и сливает pull request'ы, отвечает на `@codeagent`
в issues. Работает на **бесплатных LLM** (OpenRouter `:free`, Groq, Google Gemini,
Cerebras, Mistral) или полностью локально через **Ollama**. Зависимостей нет — только Node.js.

> Подробный разбор возможностей Claude Code и Codex и то, как они перенесены сюда:
> [docs/RESEARCH.md](docs/RESEARCH.md)

## Возможности

- **Агентный цикл** со стримингом ответа и вызовом инструментов, как в Claude Code / Codex
- **Инструменты**: `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_dir`, `glob`, `grep`, `bash`,
  `git_*` (status, diff, log, branch, commit, merge, pull, push), `github_*` (issues, комментарии,
  PR: создать / прочитать / ревью / merge, статус CI), `web_fetch`, `todo_write`, `task` (субагент)
- **Режимы разрешений**: 📋 Plan (только чтение и план) · ✋ Ask (подтверждать всё) ·
  ✏️ Auto-edit (правки без вопросов) · ⚡ Full auto; allow/deny-правила для команд
- **Память проекта**: `AGENTS.md` / `CLAUDE.md` в корне репозитория (+ глобальный `data/AGENTS.md`), `/init` создаёт его
- **Slash-команды**: `/init /review /commit /pr /test /fix-issue N /explain /compact /clear /mode` и свои из
  `.codeagent/commands/*.md`, `.claude/commands/*.md`, `.codex/prompts/*.md`
- **MCP-серверы** (формат как в `.mcp.json` Claude Code), **хуки** PreToolUse / PostToolUse / Stop
- **Автосжатие контекста**, план задач, субагенты для исследования кода
- **Веб-интерфейс**: сессии, дерево файлов, просмотр и редактирование, diff изменений, git-панель
  (ветки, commit, push/pull, merge), GitHub-панель (PR с кнопкой Merge, issues с кнопкой «🤖 Исправить»)
- **GitHub**: клонирование своих репозиториев, `@codeagent` в issue/PR через webhook или GitHub Actions
- **Headless-режим** для скриптов и CI: `node server/cli.js "задача"`

## Быстрый старт

Нужен **Node.js 20+** и **git** (желательно `ripgrep`).

```bash
git clone https://github.com/b760m670/codeagent.git
cd codeagent
cp .env.example .env      # необязательно: всё можно настроить в веб-интерфейсе
npm start
```

Откройте **http://localhost:3000** и введите токен доступа — он печатается в консоли
при запуске (или задайте свой в `ACCESS_TOKEN`). Затем:

1. ⚙ **Настройки** → выберите бесплатного провайдера, вставьте API-ключ → «Проверить соединение».
2. (для GitHub) вставьте GitHub token.
3. **＋ Репозиторий** → клонируйте репозиторий (кнопка «Мои репозитории с GitHub») или создайте пустой.
4. Напишите задачу в чат. Например: `/init`, потом «Добавь эндпоинт /health с тестом и открой PR».

## Бесплатные LLM

| Провайдер | Где взять ключ | Модель по умолчанию | Примечание |
|---|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `openrouter/free` | модели с суффиксом `:free`; `openrouter/free` сам выбирает бесплатную модель с поддержкой инструментов |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | `openai/gpt-oss-120b` | очень быстро, дневные лимиты на токены |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.5-flash` | большой контекст |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) | `gpt-oss-120b` | |
| Mistral | [console.mistral.ai](https://console.mistral.ai/api-keys) | `devstral-small-latest` | бесплатный план «Experiment» |
| Ollama | [ollama.com](https://ollama.com/download) | `qwen2.5-coder:14b` | полностью локально и бесплатно, без лимитов |

Подойдёт любой OpenAI-совместимый API (LM Studio, vLLM, llama.cpp server…) — выберите «Custom».
Лимиты бесплатных тарифов меняются; укажите **запасные модели** — при ошибке 429 агент
автоматически переключится. Для агентной работы нужна модель с поддержкой
tool calling; лучше всего себя показывают крупные модели (gpt-oss-120b, Qwen3-Coder, Kimi K2, DeepSeek, Gemini Flash).

## Как открыть по ссылке без своего домена

| Способ | Ссылка | Как |
|---|---|---|
| Локально | `http://localhost:3000` | `npm start` |
| **GitHub Codespaces** (бесплатные часы каждый месяц) | `https://<имя>-3000.app.github.dev` | Code → Codespaces → Create. Сервер стартует сам (`.devcontainer`), порт 3000 откроется в браузере. Ссылка приватная, по умолчанию доступна только вам |
| **Cloudflare Tunnel** (бесплатно, без аккаунта) | `https://<случайное>.trycloudflare.com` | `npm start`, затем в другом терминале `./scripts/tunnel.sh`, или `docker compose --profile tunnel up -d` |
| Docker на любом сервере | `http://<IP>:3000` | `docker compose up -d --build` (подойдёт бесплатный VPS, например Oracle Cloud Always Free) |

Домен понадобится только если захотите постоянный красивый адрес.

## Docker (рекомендуется)

Агент выполняет команды, поэтому безопаснее держать его в контейнере:

```bash
cp .env.example .env    # укажите ACCESS_TOKEN, LLM_API_KEY, GITHUB_TOKEN
docker compose up -d --build
docker compose logs -f codeagent
# публичная ссылка без домена:
docker compose --profile tunnel up -d && docker compose logs tunnel | grep trycloudflare
```

Данные (репозитории, сессии, настройки) лежат в томе `codeagent-data`.

## GitHub

**Токен.** Создайте fine-grained token на [github.com/settings/tokens](https://github.com/settings/personal-access-tokens/new)
с доступом к нужным репозиториям и правами: Contents — Read and write, Pull requests — Read and write,
Issues — Read and write, Metadata — Read, Checks — Read. Токен не записывается в `.git/config`:
git получает его через переменные окружения только на время команды.

**`@codeagent` в issues и PR — вариант 1, webhook на сервер.**
В репозитории: Settings → Webhooks → Add webhook:
- Payload URL: `https://<ваша-ссылка>/api/github/webhook`
- Content type: `application/json`, Secret: тот же, что `GITHUB_WEBHOOK_SECRET` в настройках
- События: Issues, Issue comments, Pull request review comments

Теперь комментарий `@codeagent добавь валидацию email` от владельца или коллаборатора
запускает агента: он клонирует репозиторий, создаёт ветку `codeagent/issue-N-…`,
делает изменения, пушит, открывает PR (`Closes #N`) и отвечает в issue. В PR агент
дописывает коммиты в ветку этого PR. Задачи одного репозитория выполняются по очереди;
сессия видна в веб-интерфейсе (🐙).

**Вариант 2 — без сервера, в GitHub Actions.** Скопируйте
[`examples/codeagent-action.yml`](examples/codeagent-action.yml) в `.github/workflows/` целевого
репозитория и добавьте секрет `LLM_API_KEY`. Для публичных репозиториев минуты Actions бесплатны.

## Headless-режим (CLI)

```bash
node server/cli.js "почини падающий тест" --cwd ./my-repo --mode auto
echo "объясни архитектуру" | node server/cli.js --cwd ./my-repo --mode plan
node server/cli.js /review --cwd ./my-repo --mode plan --json
```

Режимы: `plan`, `acceptEdits` (по умолчанию: правки разрешены, shell и сеть запрещены), `auto`.

## Настройка агента

**AGENTS.md** в корне репозитория — инструкции для агента (команды сборки и тестов, стиль кода,
подводные камни). Читаются также `CLAUDE.md` и `.codeagent/AGENTS.md`, а глобальные — из `data/AGENTS.md`.

**Свои команды** — `.codeagent/commands/deploy.md`:

```markdown
---
description: Задеплоить на staging
---
Собери проект, прогони тесты и задеплой на $ARGUMENTS через ./deploy.sh
```

Вызов: `/deploy staging`.

**MCP-серверы** (⚙ → MCP), формат как в Claude Code:

```json
{
  "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
  "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/db"] }
}
```

Инструменты появятся у агента как `mcp__postgres__query` и т.п.

**Хуки** (⚙ → hooks). Получают событие JSON в stdin, переменные `TOOL_NAME`, `FILE`;
`exit 2` в PreToolUse блокирует вызов, stderr уходит модели как причина:

```json
{
  "PostToolUse": [{ "matcher": "edit_file|write_file|multi_edit", "command": "npx prettier --write \"$FILE\" 2>/dev/null || true" }],
  "PreToolUse": [{ "matcher": "bash", "command": "grep -q 'git push --force' && { echo 'force push запрещён' >&2; exit 2; } || exit 0" }],
  "Stop": [{ "command": "npm test --silent" }]
}
```

## Безопасность

- Веб-интерфейс закрыт токеном доступа (cookie HttpOnly + SameSite=Strict, защита от CSRF, ограничение попыток входа).
  Не публикуйте ссылку вместе с токеном.
- В режиме **Ask** каждая правка и команда подтверждается; **Full auto** используйте только в изолированной среде (Docker, Codespaces).
- Инструменты работы с файлами не выходят за пределы рабочего пространства (проверяются и симлинки);
  `bash` — это настоящий shell, поэтому изоляцию даёт контейнер.
- Webhook проверяет подпись `X-Hub-Signature-256` и принимает задачи только от OWNER / MEMBER / COLLABORATOR.

## Архитектура

```
server/
  index.js          HTTP API, SSE-стрим событий, статика, авторизация, webhook
  config.js         настройки (data/settings.json + .env), пресеты бесплатных провайдеров
  runtime.js        живые сессии: агент, подписчики SSE, буфер событий
  sessions.js       хранение сессий (data/sessions/*.json)
  workspaces.js     репозитории (data/workspaces/*): клон, дерево файлов, git-операции
  cli.js            headless-режим
  agent/agent.js    агентный цикл, разрешения, хуки, автосжатие, субагент `task`
  agent/prompt.js   системный промпт + AGENTS.md/CLAUDE.md
  agent/commands.js slash-команды
  llm/provider.js   клиент OpenAI-совместимого API: стриминг, tool calls, ретраи, fallback
  tools/            fs, shell, git, github, web/todo; index.js — реестр и политика разрешений
  mcp/client.js     MCP-клиент (stdio, JSON-RPC)
  github/           REST-клиент GitHub, webhook
  hooks.js          хуки жизненного цикла
web/                SPA без сборки: index.html, app.js, md.js, style.css
test/               node:test — юнит-тесты и e2e с фейковым LLM-сервером
```

Тесты: `npm test` (фейковый OpenAI-совместимый сервер проигрывает сценарий: правка файлов,
подтверждение команд, ветка и коммит, отказ в разрешении, прерывание, slash-команды).

## Дорожная карта

- Параллельные задачи в отдельных git worktree (как облачные задачи Codex)
- Изображения во входных сообщениях (скриншоты ошибок, макеты)
- Фоновые процессы (dev-сервер) с просмотром логов
- Расширение для VS Code поверх того же API
- Нативный клиент Anthropic / Gemini API (кэширование промптов)
- Песочница для `bash` без Docker (bubblewrap / firejail)

## Лицензия

MIT
