# Integracja Toggl 2.0 → Pomodoro (polling + Firebase Cloud Function)

Kierunek **B**: aktywność w Toggl steruje stanem Pomodoro. Ponieważ **Toggl 2.0
(Focus) nie ma webhooków**, funkcja Firebase **odpytuje** (polling) bieżący wpis
i zapisuje do Firestore (`pomodoro/timer`), a web i mobile podchwytują zmianę.

```
Cloud Scheduler (co 3 min) --> Cloud Function togglPoll
                                   | GET focus.toggl.com/.../tracking/current
                                   v  (200 = leci, 204 = nic)
                         Firestore  pomodoro/timer
                                   |  (sync)
                                   v
                              web + mobile
```

## Status — WDROŻONE i działa (polling, 2026-10-28)

Implementacja: `functions/index.js`. Na produkcji:
- **Funkcja:** `togglPoll` — scheduled (Cloud Scheduler **co 3 min**), Gen2,
  `europe-west1`, Node 22, `maxInstances: 1`.
- **Sekret:** `TOGGL_FOCUS_TOKEN` = klucz Toggl 2.0 `toggl_sk_` (Bearer).
- **Endpoint:** `GET focus.toggl.com/api/organizations/6684157/workspaces/6711899/tracking/current`
  → `200` (leci wpis; pole `type`, np. `activity`) = **praca**; `204` (nic nie leci) = **przerwa**.
- **Mapowanie:** pojawił się trwający wpis → Pomodoro **praca**; zniknął (stop) →
  **przerwa**. Śledzi `togglEntryId`, żeby rozpoznać zmianę.
- **Opóźnienie:** do ~3 min (interwał pollingu) — Toggl 2.0 nie oferuje push.

**Kluczowe wnioski (łatwo się potknąć):**
- **Toggl 2.0 (Focus) NIE MA webhooków** (sprawdzone w pełnym OpenAPI: „subscription"
  tam = płatności Stripe; `time-entries/stream` to tylko streamowana lista, nie eventy).
  Polling `tracking/current` to jedyna droga dla kierunku „z Toggla".
- **Webhooki Track nie pomagają:** konto jest na 2.0, a **Live Sync 2.0→Track lustrzy
  tylko UKOŃCZONE bloki** (po stopie), nie stan „na żywo" — Track nigdy nie dostaje
  trwającego wpisu, więc webhook startu nie odpala. (Była wdrożona próba webhookowa,
  subskrypcja Track `131101` — porzucona; reszta tego dokumentu to ten nieaktualny plan.)
- **Klucz `toggl_sk_` jest JEDEN na użytkownika** (regeneracja unieważnia stary) i
  **współdzielony z automatyzacją `toggle-to-notion`** (GitHub secret `TOGGL_TOKEN`) —
  przy regeneracji trzeba zaktualizować oba sekrety.
- **Limit Toggl Free ~30 zapytań/h** na ten jeden klucz — stąd polling co 3 min (~20/h).
- **Trzymać `auto` OFF** w Pomodoro, inaczej przerwa auto-przeskoczy z powrotem na pracę.

---
_Poniżej: pierwotny plan WEBHOOKOWY (Track) — zachowany jako referencja, **nie jest używany** (Toggl 2.0 nie ma webhooków)._

## Warunki wstępne
- Plan **Blaze** (pay-as-you-go) w Firebase — wymagany do deployu funkcji.
  W praktyce koszt ~0 zł (ruch mieści się w darmowym progu), ale trzeba podpiąć
  kartę. Zabezpieczenie przed kosztami → patrz sekcja niżej.
- Node.js + `npm` lokalnie, Firebase CLI (`npm i -g firebase-tools`).
- Konto Toggl Track z tokenem API (Toggl → Profile settings → API Token) oraz
  `workspace_id`.

## Zabezpieczenie kosztów (WAŻNE)
**Budżet w Firebase/Google Cloud to tylko ALERT mailowy, NIE twardy limit.** Po
przekroczeniu nic się samo nie wyłącza (a dane rozliczeniowe mają opóźnienie).
Sam budżet nie ochroni przed bugiem lecącym w pętli — trzeba dołożyć twarde
bezpieczniki:

1. **`maxInstances` na funkcji (najprostsze).** Ogranicza liczbę równoległych
   instancji, więc bug w pętli nie rozmnoży się w nieskończoność; nadmiarowe
   żądania są odrzucane. Ustaw np. `maxInstances: 2` (patrz kod w kroku 4).
2. **Twardy limit quoty (hard cap).** Google Cloud Console → IAM & Admin →
   **Quotas** → ogranicz dzienną liczbę wywołań Cloud Functions. Po przekroczeniu
   żądania są **odrzucane**, nie naliczane.
3. **Auto-wyłączanie billingu (opcja atomowa).** Oficjalny wzorzec Google:
   budżet → Pub/Sub → funkcja, która **odpina konto rozliczeniowe** od projektu =
   twardy stop wszystkiego. Najpewniejsze, ale ubija cały projekt gdy zadziała
   (apka przestaje działać do ręcznego przywrócenia) i wymaga setupu.
   Dok.: https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage
4. **Budżet z alertem** (Google Cloud Console → Billing → Budgets & alerts, np.
   5 zł) — jako wczesne ostrzeżenie, NIE jako limit.

**Rekomendowany zestaw:** `maxInstances: 1–2` + dzienny cap quoty + budżet z
alertem. Największe realne ryzyko to pętla sprzężenia zwrotnego A↔B (patrz
Uwagi).

## Kroki

### 1. Włącz Blaze + bezpieczniki kosztów
Firebase Console → projekt `pomodoro-d9a43` → Upgrade → plan Blaze. Następnie
ustaw zabezpieczenia z sekcji **„Zabezpieczenie kosztów"** powyżej: budżet z
alertem (to tylko powiadomienie) ORAZ co najmniej `maxInstances` na funkcji i/lub
dzienny cap quoty (to twarde limity).

### 2. Zainicjuj Functions w repo
```bash
cd D:\PROJEKTY\PRYWATNE\APPS\POMODORO
firebase login
firebase init functions          # wybierz projekt pomodoro-d9a43, język JS lub TS
```
Powstaje folder `functions/`. (Firestore Admin SDK omija reguły bezpieczeństwa,
więc funkcja może pisać do `pomodoro/timer` niezależnie od `firestore.rules`.)

### 3. Sekrety (nie w kodzie)
Wygeneruj losowy sekret dla podpisu webhooka (HMAC) i zapisz w Secret Managerze:
```bash
firebase functions:secrets:set TOGGL_WEBHOOK_SECRET
```
(ten sam sekret podasz przy tworzeniu subskrypcji w kroku 6).

### 4. Napisz funkcję HTTPS `togglWebhook`
Funkcja `onRequest` musi obsłużyć trzy rzeczy:

1. **Walidacja endpointu (handshake).** Przy tworzeniu/aktywacji subskrypcji
   Toggl wysyła payload walidacyjny z polem `validation_code` (oraz
   `payload: "ping"`). Odpowiedz `200` i zwróć `validation_code` (zwykle jako
   `{ "validation_code": "<ten sam kod>" }`), żeby potwierdzić endpoint.
2. **Weryfikacja podpisu.** Każdy event jest podpisany HMAC-SHA256. Policz HMAC z
   **surowego** ciała żądania i sekretu (`TOGGL_WEBHOOK_SECRET`) i porównaj z
   nagłówkiem `x-webhook-signature-256`. Jeśli się nie zgadza → `403`.
   (W Cloud Functions użyj `req.rawBody` do policzenia podpisu.)
3. **Obsługa eventu.** Z payloadu odczytaj `metadata.action`
   (`created`/`updated`/`deleted`) i encję (np. time entry). Zmapuj na stan
   Pomodoro i zapisz do Firestore (patrz krok 5). Odpowiedz `200` szybko
   (Toggl ponawia przy nie-2xx).

Szkic (Functions v2, Node):
```js
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
admin.initializeApp();
const TOGGL_WEBHOOK_SECRET = defineSecret("TOGGL_WEBHOOK_SECRET");

// maxInstances = twardy bezpiecznik: bug w pętli nie rozmnoży instancji.
exports.togglWebhook = onRequest({ maxInstances: 2, secrets: [TOGGL_WEBHOOK_SECRET] }, async (req, res) => {
  const body = req.body || {};

  // 1. Handshake walidacyjny
  if (body.validation_code) {
    return res.status(200).json({ validation_code: body.validation_code });
  }

  // 2. Weryfikacja podpisu (HMAC-SHA256 z rawBody)
  const sig = req.get("x-webhook-signature-256") || "";
  const expected = "sha256=" + crypto
    .createHmac("sha256", TOGGL_WEBHOOK_SECRET.value())
    .update(req.rawBody)
    .digest("hex");
  if (sig !== expected) return res.status(403).send("bad signature");

  // 3. Mapowanie eventu → stan Pomodoro (do dopracowania w kroku 5)
  const action = body.metadata && body.metadata.action;   // created/updated/deleted
  const entry  = body.payload;                              // time entry
  const ref = admin.firestore().doc("pomodoro/timer");

  if (entry && entry.duration < 0 /* trwający wpis */) {
    // Toggl: timer wystartował → Pomodoro: start pracy
    await ref.set({ running: true, phase: "work",
      endsAt: Date.now() + /* workMins */ 25 * 60 * 1000 }, { merge: true });
  } else if (action === "updated" && entry && entry.stop) {
    // Toggl: timer zatrzymany → Pomodoro: stop
    await ref.set({ running: false, endsAt: null }, { merge: true });
  }

  return res.status(200).send("ok");
});
```

### 5. Zdefiniuj mapowanie Toggl → Pomodoro
To część produktowa — zdecyduj dokładnie:
- Start wpisu w Toggl → start timera pracy (ustaw `running/phase/endsAt`...).
- Stop wpisu → `running=false` (albo pauza).
- Ewentualnie: projekt/opis z Toggla → nazwa zadania.

Pola dokumentu `pomodoro/timer` są w pamięci projektu (`firestore-sync-and-daily-reset`):
`running, phase, endsAt, secsLeft, workMins, breakMins, auto, ...`. Pisząc,
używaj tych samych pól, żeby web i mobile poprawnie podchwyciły stan.

### 6. Zdeployuj funkcję i utwórz subskrypcję w Toggl
```bash
firebase deploy --only functions
```
Zapamiętaj URL, np. `https://<region>-pomodoro-d9a43.cloudfunctions.net/togglWebhook`.

Utwórz subskrypcję (Webhooks API v1):
```bash
curl -X POST "https://api.track.toggl.com/webhooks/api/v1/subscriptions/<WORKSPACE_ID>" \
  -u "<TOGGL_API_TOKEN>:api_token" \
  -H "Content-Type: application/json" \
  -d '{
    "url_callback": "https://<region>-pomodoro-d9a43.cloudfunctions.net/togglWebhook",
    "event_filters": [{"entity":"time_entry","action":"*"}],
    "enabled": true,
    "description": "Pomodoro sync",
    "secret": "<TEN_SAM_SEKRET_CO_W_KROKU_3>"
  }'
```
Toggl zwaliduje endpoint (wyśle `validation_code` → funkcja go odeśle). Jeśli
trzeba, aktywuj/zwaliduj subskrypcję ponownie zgodnie z dokumentacją.

### 7. Test
- Wystartuj i zatrzymaj timer w Toggl.
- Logi funkcji: `firebase functions:log` — sprawdź, że event dotarł i podpis OK.
- Firestore Console → `pomodoro/timer` — czy pola się zmieniły.
- Web/mobile — czy stan się zsynchronizował.

## Uwagi / pułapki
- **Pętla sprzężenia zwrotnego:** jeśli kiedyś dodasz też kierunek A
  (Pomodoro → Toggl), zmiana z Toggla wywoła zmianę w Pomodoro, która może
  wywołać zmianę w Toggl → nieskończona pętla. Dodaj znacznik źródła zmiany albo
  ignoruj eventy wywołane przez samą integrację.
- **Surowe ciało do HMAC:** podpis liczony z `req.rawBody`, nie z
  sparsowanego JSON-a (inaczej nie zgadza się bajt w bajt).
- **Reguły Firestore:** Admin SDK w funkcji omija `firestore.rules`, więc nie
  trzeba ich luzować.
- **Region i zimny start:** pierwszy webhook po bezczynności może być wolniejszy;
  Toggl ponawia przy nie-2xx.
- **Koszt:** wywołania webhooka są drobne, mieszczą się w darmowym progu Blaze;
  trzymaj budżet z alertem i tak.

## Dokumentacja
- Webhooks API: https://developers.track.toggl.com (sekcja Webhooks) oraz
  https://community.toggl.com/t/webhooks-api-overview/395
- REST API v9: https://developers.track.toggl.com
- Firebase Functions: https://firebase.google.com/docs/functions
