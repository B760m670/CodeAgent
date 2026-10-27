# Исследование: Claude Code и OpenAI Codex

Цель — понять, из чего состоят Claude Code и Codex, и какие из их возможностей
воспроизводит CodeAgent. Источники — официальная документация
([code.claude.com/docs](https://code.claude.com/docs/en/features-overview),
[developers.openai.com/codex](https://developers.openai.com/codex/agent-approvals-security.md))
и обзоры сообщества (октябрь 2026).

## 1. Общая архитектура обоих продуктов

Оба инструмента — это **агентный цикл** (agentic loop) поверх LLM с вызовом инструментов:

```
пользователь → [system prompt + история + описание инструментов] → LLM
LLM → текст и/или tool_calls → исполнение инструментов (с проверкой разрешений)
результаты инструментов → обратно в LLM → … пока модель не ответит без tool_calls
```

Всё остальное — это слои вокруг цикла: память проекта, разрешения, расширения
(MCP, хуки, команды, субагенты), интерфейсы (CLI, IDE, веб, GitHub).

## 2. Claude Code (Anthropic)

| Возможность | Что делает |
|---|---|
| Встроенные инструменты | Read, Write, Edit/MultiEdit (точная замена строки), Glob, Grep (ripgrep), Bash, WebFetch/WebSearch, TodoWrite, NotebookEdit |
| CLAUDE.md | Память проекта: инструкции, которые подгружаются в каждую сессию (глобальный, проектный, вложенные). `/init` генерирует его |
| Режимы разрешений | default (спрашивать), acceptEdits, plan (только чтение и план), bypassPermissions; allow/deny-правила для команд (`Bash(npm test:*)`) |
| Субагенты | Задача выполняется в отдельном контексте, в основной возвращается только итог; свои инструменты и промпт (`.claude/agents/*.md`) |
| Хуки | PreToolUse / PostToolUse / Stop / UserPromptSubmit и др.: shell-команды на события жизненного цикла; exit 2 блокирует действие |
| MCP | Model Context Protocol — подключение внешних сервисов (БД, Jira, Slack, браузер…) через `.mcp.json` |
| Slash-команды и Skills | Свои команды в `.claude/commands/*.md` с `$ARGUMENTS`; Skills — пакеты инструкций, загружаемые по необходимости |
| Сжатие контекста | `/compact` и автокомпакт: старая история заменяется кратким резюме |
| Сессии | Возобновление (`--resume`, `--continue`), история диалогов |
| Headless | `claude -p "задача"` для скриптов и CI, вывод в JSON/stream-json |
| GitHub | Claude Code GitHub Actions: `@claude` в issue/PR → агент делает ветку, коммиты, PR, ревью |
| Интерфейсы | Терминал, IDE (VS Code, JetBrains), десктоп, веб (claude.ai/code) с облачными контейнерами |
| Плагины, agent teams | Пакеты из команд/агентов/хуков/MCP; несколько агентов, работающих параллельно |

## 3. OpenAI Codex

| Возможность | Что делает |
|---|---|
| Codex CLI | Агент в терминале (open source, Rust), TUI, `codex exec` — headless-режим |
| AGENTS.md | Аналог CLAUDE.md: глобальный + корень репозитория + текущая папка, объединяются сверху вниз (лимит по умолчанию 32 KB) |
| Sandbox | Режимы `read-only`, `workspace-write`, `danger-full-access`; по умолчанию сеть отключена, запись — только в рабочую папку (OS-изоляция) |
| Approval policy | Когда спрашивать подтверждение: `untrusted`, `on-request`, `never` (старые названия: Suggest / Auto Edit / Full Auto) |
| Codex Cloud | Задачи в изолированных контейнерах: на этапе setup есть сеть для установки зависимостей, затем агент работает офлайн; результат — diff/PR; несколько задач параллельно |
| Code review | Ревью PR на GitHub, автоматически или по `@codex review`, с учётом AGENTS.md |
| MCP | Подключение MCP-серверов через `config.toml` |
| Custom prompts | Свои промпты-команды (`~/.codex/prompts/*.md`) |
| IDE-расширение и веб | VS Code / Cursor, веб-интерфейс chatgpt.com/codex |

## 4. Что общего — «ядро», которое нужно воспроизвести

1. Агентный цикл с потоковым выводом и вызовом инструментов.
2. Инструменты: чтение/поиск/правка файлов (точная замена строк), shell, git, веб.
3. Память проекта (AGENTS.md / CLAUDE.md).
4. Модель разрешений: план → подтверждение → автоправки → полный автомат.
5. План задач (todo) для многошаговой работы.
6. Субагенты для исследования без засорения контекста.
7. Сжатие контекста.
8. Расширяемость: MCP, хуки, пользовательские команды.
9. Git-процесс: ветка → коммит → push → PR → ревью → merge.
10. GitHub-интеграция по упоминанию (`@claude` / `@codex`).
11. Headless-режим для CI.
12. Интерфейс: просмотр структуры проекта, diff, история сессий.

## 5. Как это реализовано в CodeAgent

| Возможность | Claude Code | Codex | CodeAgent |
|---|---|---|---|
| Агентный цикл со стримингом | ✓ | ✓ | ✓ `server/agent/agent.js` |
| LLM | Claude (платно) | GPT (платно) | **Любой OpenAI-совместимый API**: бесплатные OpenRouter `:free`, Groq, Gemini, Cerebras, Mistral, локальный Ollama; запасные модели при 429 |
| read/write/edit/multi_edit/glob/grep/ls | ✓ | ✓ | ✓ `server/tools/fs.js` (edit требует предварительного чтения, как в Claude Code) |
| Bash с таймаутом и прерыванием | ✓ | ✓ | ✓ `server/tools/shell.js` (убивается вся группа процессов) |
| Git-инструменты | через Bash | через Bash | ✓ отдельные: status, diff, log, branch, commit, merge, pull, push |
| GitHub API | через `gh`/MCP | ✓ | ✓ issues, комментарии, PR (создать/прочитать/ревью/merge), CI-статусы |
| AGENTS.md / CLAUDE.md | CLAUDE.md | AGENTS.md | ✓ оба + глобальный `data/AGENTS.md`, `/init` |
| Режимы разрешений | default/acceptEdits/plan/bypass | approval + sandbox | ✓ plan / ask / acceptEdits / auto + allow/deny-правила команд + «разрешить в этой сессии» |
| TodoWrite | ✓ | ✓ (plan) | ✓ `todo_write`, отображается в UI |
| Субагенты | ✓ | — | ✓ инструмент `task` (только чтение, свой контекст) |
| Автосжатие контекста | ✓ | ✓ | ✓ при 75% окна + `/compact` |
| Хуки | ✓ | частично | ✓ PreToolUse (exit 2 блокирует) / PostToolUse / Stop |
| MCP | ✓ | ✓ | ✓ stdio-клиент, формат как в `.mcp.json` |
| Slash-команды | ✓ | ✓ | ✓ встроенные (`/init /review /commit /pr /test /fix-issue /explain /compact /clear /mode`) + свои из `.codeagent/commands`, `.claude/commands`, `.codex/prompts` |
| Сессии и возобновление | ✓ | ✓ | ✓ хранятся в `data/sessions`, переживают перезагрузку страницы и сервера |
| Headless-режим | `claude -p` | `codex exec` | ✓ `node server/cli.js "задача"` (`--json`, stdin) |
| `@mention` в GitHub | ✓ Actions | ✓ | ✓ двумя способами: webhook на сервер или GitHub Actions (`examples/codeagent-action.yml`) |
| Веб-интерфейс | claude.ai/code | chatgpt.com/codex | ✓ чат, дерево файлов, просмотр/редактирование, diff, git-панель, PR/issues с кнопками Merge и «Исправить» |
| Изоляция | облачные контейнеры | OS-sandbox | Docker-контейнер (`docker compose up`); внутри — проверка путей, deny-правила |
| IDE-плагины, изображения, worktrees для параллельных задач, LSP | ✓ | ✓ | пока нет — см. «Дорожная карта» в README |

## 6. Ключевые решения

- **Только OpenAI-совместимый протокол.** Его поддерживают почти все бесплатные
  провайдеры и локальные движки (Ollama, LM Studio, vLLM), так что один клиент
  покрывает всё, а модель меняется в настройках без кода.
- **Без зависимостей.** Сервер — чистый Node.js ≥ 20 (http, child_process,
  fetch). Нечего ставить, нечего обновлять, легко развернуть где угодно.
- **Точная замена строк вместо патчей.** Слабым бесплатным моделям проще
  повторить фрагмент текста, чем составить корректный unified diff; при ошибке
  инструмент подсказывает, что пошло не так (нет совпадения / несколько совпадений).
- **Отдельные git/GitHub-инструменты** вместо «всё через bash» — бесплатные
  модели заметно надёжнее вызывают узкие инструменты со схемой.
- **Токен GitHub не пишется в `.git/config`** — передаётся через
  `GIT_CONFIG_*`-переменные окружения только на время команды.
