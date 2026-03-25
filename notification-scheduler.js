// notification-scheduler.js
// Beheert alle push notification-logica voor MycoScope PWA
// Vraagt toestemming na les 3, plant dagelijkse reminders

const LAB_TIPS = [
  { tip: "Bij RNA-extractie: werk altijd op ijs en gebruik RNase-vrije tips. RNasen zijn overal.", url: "/cursus#u7l0" },
  { tip: "Nanopore-reads verbeteren drastisch als je hogere-molecuulgewicht DNA extraheert. Gebruik een bead-cleanup voor fragmenten >10 kb.", url: "/cursus#u2l2" },
  { tip: "CRISPR-efficiëntie in A. fumigatus stijgt met 3-5× als je RNP (ribonucleoproteïne) gebruikt i.p.v. plasmide.", url: "/cursus#u5l1" },
  { tip: "Voor ITS-barcoding: gebruik de ITS_RefSeq_Fungi BLAST-database, niet de algemene nt-database.", url: "/cursus#u4l2" },
  { tip: "antiSMASH-analyse duurt op een laptop ~5 min voor een schimmelgenoom. Voer het uit terwijl je de cursus volgt.", url: "/cursus#u6l2" },
  { tip: "DESeq2 heeft minimaal 3 biologische replicaten per conditie nodig. Technische replicaten tellen niet.", url: "/cursus#u7l1" },
  { tip: "Controleer altijd je BUSCO-score vóór annotatie. Onder 90% = assembly waarschijnlijk incompleet.", url: "/cursus#u3l1" },
  { tip: "gRNA-ontwerp: vermijd TTTT in de spacer — dit is een Pol III-terminatiesignaal.", url: "/cursus#u5l2" },
  { tip: "Voor polyploïde planten: activeer de polyploïdie-modus in MycoScope zodat alle homologe kopieën worden gescand.", url: "/cursus#u10l4" },
  { tip: "Backblaze B2 is ~6× goedkoper dan AWS S3 voor archivering van ruwe FASTQ-bestanden.", url: "/cursus#u9l2" },
];

// ─── Klasse NotificationScheduler ────────────────────────────

export class NotificationScheduler {
  constructor() {
    this.swReg = null;
    this.vapidKey = null; // vul in bij deployment
  }

  // ── Initialisatie ────────────────────────────────────────

  async init(swRegistration) {
    this.swReg = swRegistration;

    // Luister naar berichten van de service worker
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'navigate' && e.data.lessonId) {
        window.dispatchEvent(new CustomEvent('sw-navigate', { detail: e.data }));
      }
    });

    // Herstel bestaande dagelijkse reminder als toestemming al gegeven
    if (Notification.permission === 'granted') {
      this._scheduleDailyCheck();
    }
  }

  // ── Toestemming vragen (na les 3) ────────────────────────

  async requestAfterLesson(lessonCount) {
    // Vraag alleen na 3e voltooide les, en alleen als nog niet gevraagd
    if (lessonCount !== 3) return false;
    if (Notification.permission !== 'default') return Notification.permission === 'granted';

    // Toon eerst een in-app uitlegkaart (niet meteen de browser-popup)
    return new Promise(resolve => {
      window.dispatchEvent(new CustomEvent('notification-permission-request', {
        detail: {
          onAccept: async () => {
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
              await this._subscribe();
              this._scheduleDailyCheck();
              await this._sendWelcomeNotif();
              resolve(true);
            } else {
              resolve(false);
            }
          },
          onDecline: () => resolve(false),
        }
      }));
    });
  }

  // ── Service Worker Push Subscription ────────────────────

  async _subscribe() {
    if (!this.swReg || !this.vapidKey) return;
    try {
      const existing = await this.swReg.pushManager.getSubscription();
      if (existing) return existing;

      const sub = await this.swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(this.vapidKey),
      });

      // Stuur subscription naar server (als die bestaat)
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      }).catch(() => {}); // stil falen als geen server

      return sub;
    } catch (err) {
      console.warn('Push subscription failed:', err);
    }
  }

  // ── Welkomstnotificatie ──────────────────────────────────

  async _sendWelcomeNotif() {
    if (!this.swReg) return;
    await new Promise(r => setTimeout(r, 2000)); // wacht 2s
    await this.swReg.showNotification('📚 Notificaties aan!', {
      body: 'Je ontvangt dagelijkse herinneringen en tips. Je kunt dit altijd uitzetten via Instellingen.',
      icon: '/icons/icon-192.png',
      tag: 'welcome',
    });
  }

  // ── Dagelijkse check-logica ──────────────────────────────

  _scheduleDailyCheck() {
    // Voer elke 30 minuten een check uit terwijl de app open is
    this._dailyCheckInterval = setInterval(() => this._checkAndNotify(), 30 * 60 * 1000);
    // Eerste check na 5 minuten
    setTimeout(() => this._checkAndNotify(), 5 * 60 * 1000);
  }

  async _checkAndNotify() {
    if (Notification.permission !== 'granted') return;

    const state = this._loadState();
    const now = new Date();
    const today = now.toDateString();
    const hour = now.getHours();
    const minutes = now.getMinutes();

    // Streak-save: om 21:00-22:00 als vandaag nog niet geleerd
    if (hour >= 21 && hour < 22 && state.lastStudyDay !== today && state.streak > 0) {
      if (!state.streakSaveNotifToday) {
        this._showLocal({
          type: 'streak_save',
          streak: state.streak,
          minutesLeft: (22 - hour) * 60 - minutes,
          nextLesson: state.nextLesson,
        });
        this._saveState({ ...state, streakSaveNotifToday: today });
      }
    }

    // Dagelijkse streak-reminder: om 19:00 als vandaag nog niet geleerd
    if (hour >= 19 && hour < 20 && state.lastStudyDay !== today && state.streak > 0) {
      if (!state.dailyReminderToday) {
        this._showLocal({
          type: 'streak_reminder',
          streak: state.streak,
          nextLesson: state.nextLesson,
        });
        this._saveState({ ...state, dailyReminderToday: today });
      }
    }

    // Lab-tip: om 10:00, max 1 per dag
    if (hour >= 10 && hour < 11 && !state.labTipToday) {
      const tip = LAB_TIPS[state.tipIndex % LAB_TIPS.length];
      this._showLocal({ type: 'lab_tip', tip: tip.tip, url: tip.url });
      this._saveState({ ...state, labTipToday: today, tipIndex: (state.tipIndex || 0) + 1 });
    }

    // Reset dagelijkse vlaggen bij nieuw dag
    if (state.streakSaveNotifToday && state.streakSaveNotifToday !== today) {
      this._saveState({ ...state, streakSaveNotifToday: null, dailyReminderToday: null, labTipToday: null });
    }
  }

  // ── Notificaties aansturen vanuit de app ─────────────────

  // Aanroepen wanneer een les voltooid is
  async onLessonComplete(lessonId, unitTitle, xp, isUnitComplete, lessonsInUnit) {
    const state = this._loadState();
    const today = new Date().toDateString();

    // Update staat
    this._saveState({
      ...state,
      lastStudyDay: today,
      nextLesson: this._getNextLessonId(lessonId),
      streak: state.lastStudyDay === this._yesterday() ? (state.streak || 0) + 1 : 1,
    });

    // Unit voltooid: speciale notificatie (vertraagd, om te vermijden dat het storend is)
    if (isUnitComplete && Notification.permission === 'granted') {
      setTimeout(() => {
        this._showLocal({ type: 'unit_complete', unitTitle, xp, lessonsCount: lessonsInUnit });
      }, 3000);
    }
  }

  // Aanroepen wanneer nieuwe content beschikbaar is
  async announceNewUnit(unitId, unitTitle) {
    if (Notification.permission !== 'granted') return;
    this._showLocal({ type: 'new_unit', unitId, unitTitle });
  }

  // ── Lokale notificatie tonen ─────────────────────────────

  async _showLocal(data) {
    if (!this.swReg || Notification.permission !== 'granted') return;
    const [title, opts] = window._buildNotif?.(data) || this._fallbackBuildNotif(data);
    await this.swReg.showNotification(title, opts);
  }

  _fallbackBuildNotif(data) {
    return [data.title || 'MycoScope', {
      body: data.body || data.tip || '',
      icon: '/icons/icon-192.png',
      tag: data.type || 'general',
    }];
  }

  // ── Instellingen ─────────────────────────────────────────

  async disable() {
    clearInterval(this._dailyCheckInterval);
    const sub = await this.swReg?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    await fetch('/api/push/unsubscribe', { method: 'POST' }).catch(() => {});
  }

  getSettings() {
    const state = this._loadState();
    return {
      enabled: Notification.permission === 'granted',
      streak_reminder: state.streakReminderEnabled !== false,
      lab_tips: state.labTipsEnabled !== false,
      achievements: state.achievementsEnabled !== false,
    };
  }

  async updateSettings(settings) {
    const state = this._loadState();
    this._saveState({
      ...state,
      streakReminderEnabled: settings.streak_reminder,
      labTipsEnabled: settings.lab_tips,
      achievementsEnabled: settings.achievements,
    });
    if (!settings.streak_reminder && !settings.lab_tips && !settings.achievements) {
      await this.disable();
    }
  }

  // ── State persistentie ───────────────────────────────────

  _loadState() {
    try {
      return JSON.parse(localStorage.getItem('ms_notif_state') || '{}');
    } catch { return {}; }
  }

  _saveState(state) {
    try { localStorage.setItem('ms_notif_state', JSON.stringify(state)); } catch {}
  }

  _yesterday() {
    const d = new Date(); d.setDate(d.getDate() - 1); return d.toDateString();
  }

  _getNextLessonId(currentLessonId) {
    // Eenvoudige increment: u0l0 → u0l1 → ... → u0l5 → u1l0 etc.
    // In de echte app haal je dit op uit de UNITS-array
    return currentLessonId; // placeholder
  }

  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }
}

// ─── In-app toestemmingskaart (UI-component) ─────────────────
// Luistert naar 'notification-permission-request' event

export function NotificationPermissionCard({ onAccept, onDecline }) {
  // React-component (of plain JS voor de cursus-HTML versie)
  return `
    <div style="
      position:fixed;bottom:20px;right:20px;width:320px;
      background:linear-gradient(135deg,#0E1422,#0A1020);
      border:1px solid rgba(29,191,170,.3);border-radius:14px;
      box-shadow:0 16px 48px rgba(0,0,0,.6);padding:0;overflow:hidden;
      z-index:8000;font-family:'DM Sans',sans-serif;
      animation:slideUp .3s ease;
    ">
      <div style="padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07);">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="font-size:28px;">🔔</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:#E2ECF8;">Meldingen inschakelen?</div>
            <div style="font-size:11px;color:#3A4A68;margin-top:2px;">Dagelijkse herinneringen & lab-tips</div>
          </div>
        </div>
      </div>
      <div style="padding:12px 18px;font-size:12px;color:#8898B4;line-height:1.65;">
        Je ontvangt:<br>
        🔥 Streak-herinneringen om je voortgang te bewaren<br>
        🔬 Dagelijkse lab-tip gerelateerd aan je huidige les<br>
        🏆 Melding als je een unit voltooit<br><br>
        Maximaal 1-2 meldingen per dag. Altijd uitzetten via Instellingen.
      </div>
      <div style="padding:0 18px 16px;display:flex;gap:8px;">
        <button onclick="this.closest('.notif-card').remove();${onDecline}()"
          style="flex:1;padding:9px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#3A4A68;font-size:12px;cursor:pointer;font-family:inherit;">
          Nee, bedankt
        </button>
        <button onclick="this.closest('.notif-card').remove();${onAccept}()"
          style="flex:2;padding:9px;border-radius:8px;border:1px solid rgba(29,191,170,.35);background:rgba(29,191,170,.12);color:#1DBFAA;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;">
          ✓ Inschakelen
        </button>
      </div>
    </div>
    <style>@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:none;opacity:1}}</style>
  `;
}

// ─── Integratie in de cursus-HTML ─────────────────────────────
// Voeg dit toe aan het <script> blok in mycoscope-cursus-compleet.html:
//
// import { NotificationScheduler } from './notification-scheduler.js';
// const notifScheduler = new NotificationScheduler();
//
// if ('serviceWorker' in navigator) {
//   navigator.serviceWorker.register('/sw.js').then(reg => {
//     notifScheduler.init(reg);
//   });
// }
//
// // In markLessonDone():
// const lessonCount = Object.keys(state.done).length;
// await notifScheduler.requestAfterLesson(lessonCount);
// await notifScheduler.onLessonComplete(lessonId, unit.title, 50, allDone, unit.lessons.length);
