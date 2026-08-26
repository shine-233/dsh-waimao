# dsh-waimao

**Full-stack foreign-trade customer acquisition plugin for DeepSeek Harness (dsh).** Chinese docs: [README.md](./README.md)

```
ICP profile → 3-layer Google search → contact extraction → rule filtering → AI scoring (ICP fit)
  → email verify → cold email (dry-run, threading, spintax, daily cap) → human approval → outreach (email/WhatsApp)
  → IMAP reply scan + AI classification → follow-up sequences → CRM pipeline
  → website change monitoring → quotes → close & report
```

## Highlights

- **ICP profile**: `icp_set` stores what you sell and who counts as your buyer. Scoring judges each lead's fit (yes/partial/no, with a reason — the OpenOutreach "reason per lead" idea), and email drafts know your product.
- **Lead enrichment**: fetch pages, extract emails/WhatsApp/phones/socials, rule-engine excludes suppliers/B2B platforms/directories/job boards, AI scoring 0-12 with tiers and approach advice, auto-merge into CRM.
- **Email finder & verifier**: 35+ pattern guesses + MX + SMTP RCPT probing + catch-all detection (open-source Hunter.io alternative).
- **Cold email**: zero-dep SMTP client (implicit TLS / STARTTLS / AUTH), DeepSeek-personalized drafts with knowledge-base citations, trilingual templates (EN/ES/PT, auto-Spanish for LatAm), unsubscribe footer, **dry-run master switch**, **reply threading (In-Reply-To/References)**, **spintax variants** `{a|b|c}`, **per-day send cap** to protect new domains, optional **plain-text mode**.
- **Reply loop (closed!)**: IMAP scan finds buyer replies, AI classifies them (interested / pricing / not-interested / OOO / auto / unsubscribe), auto-updates CRM to `replied`, stops sequences, auto-suppresses unsubscribes.
- **CRM pipeline**: 7-stage state machine, contact profiles, activities, cross-search dedup & merge, CSV export.
- **SOP stage machine**: 8 server-enforced stages, **human approval gate bound to content hash** (fail-closed), full audit log.
- **Knowledge base**: products / quote policies / cases / market rules with citations.
- **Intent monitoring**: cron watches customer websites for changes (hiring / new product = buying signals).
- **Automation**: cron jobs (inbox polling, sequence execution, daily report, stale alerts, reply scan, site monitor).
- **WhatsApp**: review desk (AI draft + human approve), media messages, rate-controlled broadcast (random delay + daily cap + circuit breaker).
- **Quotes**: English quotation PDF, zero dependencies.
- **50 chat tools + 5 web pages**, zero npm dependencies, Node ≥ 22.13.

## Install

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:shine-233/dsh-waimao
```

Open `http://127.0.0.1:3080/waimao/leads` after restarting `dsh web`. Configure at `/waimao/settings` (with connectivity test buttons for serp/smtp/imap/evolution/deepseek).

## Configuration

`~/.waimao/config.json` (or the settings page):

```jsonc
{
  "icp":    { "product": "professional hair dryers 1800-2400W", "buyers": "wholesalers, beauty supply distributors" },
  "serp":   { "engine": "ddg", "proxy": "http://127.0.0.1:7890", "chain": ["ddg", "serpapi"] },
  "smtp":   { "host": "smtp.gmail.com", "port": 465, "user": "", "pass": "", "from": "", "dryRun": true, "dailyCap": 300, "plainText": false },
  "imap":   { "host": "imap.gmail.com", "port": 993, "user": "", "pass": "" },
  "evolution": { "baseURL": "http://127.0.0.1:8080", "apiKey": "", "instance": "" },
  "deepseek":  { "apiKey": "" },
  "cron":   { "replyScanEveryMin": 30, "monitorEveryHour": 6 },
  "wa":     { "dailyBroadcastCap": 200, "minDelaySec": 20, "maxDelaySec": 90 }
}
```

## Compliance notes

Cold email: honor unsubscribes (built-in footer + suppression list), respect CAN-SPAM/GDPR. WhatsApp automation follows unofficial APIs (Evolution API) — warm up numbers, keep volume low, ban risk is real. Search engines: respect their ToS.

## License

MIT
