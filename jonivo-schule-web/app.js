// JONIVO public web shell version 0.2.0.
// Uses the same browser data contract tracked in RW-7/jonivo-schule.
(() => {
  'use strict';

  const D = window.JonivoWebData;
  const root = document.getElementById('app');
  let active = 'overview';
  let family = null;
  let session = null;

  const esc = (value) => String(value ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

  function setMessage(text, kind='info') {
    const box = document.getElementById('message');
    if (!box) return;
    box.className = 'message ' + kind;
    box.textContent = text || '';
    box.hidden = !text;
  }

  async function refreshState() {
    family = await D.getFamily();
    session = D.currentSession();
  }

  function shell(content) {
    const adult = !!session?.isAdult;
    return `
      <header>
        <div class="brandmark">🎓</div>
        <div><h1>JONIVO Schule</h1><div class="sub">Web/PWA · 0.9.80</div></div>
        <div class="spacer"></div>
        ${session ? `<div class="user">${esc(session.name)} · ${esc(session.role)}</div><button class="ghost" id="logout">Abmelden</button>` : ''}
      </header>
      ${session ? `
      <nav class="tabs">
        <button data-page="overview" class="${active==='overview'?'active':''}">Übersicht</button>
        <button data-page="children" class="${active==='children'?'active':''}">Kinder</button>
        <button data-page="curriculum" class="${active==='curriculum'?'active':''}">Lehrpläne</button>
        ${adult ? `<button data-page="data" class="${active==='data'?'active':''}">Daten & Abgleich</button>` : ''}
      </nav>` : ''}
      <main>
        <div id="message" class="message" hidden></div>
        ${content}
      </main>`;
  }

  function setupView() {
    root.innerHTML = shell(`
      <section class="panel narrow">
        <div class="eyebrow">Ersteinrichtung</div>
        <h2>Lokale Familie einrichten</h2>
        <p>Die Daten bleiben in der lokalen Browser-Datenbank. PIN-Prüfdaten werden nicht in Sync- oder Exportpakete geschrieben.</p>
        <form id="setupForm" class="form">
          <label>Familienname<input name="familyName" required minlength="2" maxlength="80"></label>
          <label>Name des Administrators<input name="adultName" required minlength="2" maxlength="80"></label>
          <label>PIN<input name="pin" type="password" required minlength="4" maxlength="64"></label>
          <label>PIN wiederholen<input name="pinConfirmation" type="password" required minlength="4" maxlength="64"></label>
          <button class="primary" type="submit">Familie anlegen</button>
        </form>
      </section>`);
    document.getElementById('setupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await D.setupFamily({
          familyName:f.get('familyName'),
          adultName:f.get('adultName'),
          pin:f.get('pin'),
          pinConfirmation:f.get('pinConfirmation')
        });
        await refreshState();
        loginView('Familie eingerichtet. Jetzt anmelden.');
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });
  }

  function loginView(initialMessage='') {
    root.innerHTML = shell(`
      <section class="panel narrow">
        <div class="eyebrow">Anmeldung</div>
        <h2>JONIVO Schule</h2>
        <p>Mit dem lokalen Erwachsenen- oder Kinderkonto anmelden.</p>
        <form id="loginForm" class="form">
          <label>Name<input name="name" required autocomplete="username"></label>
          <label>PIN<input name="pin" type="password" required autocomplete="current-password"></label>
          <button class="primary" type="submit">Anmelden</button>
        </form>
        <div class="dbnote">Lokale Browser-Datenbank: <b>aktiv</b> · Familienformat: <b>schema 1</b></div>
      </section>`);
    if (initialMessage) setMessage(initialMessage, 'ok');
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await D.signIn(f.get('name'), f.get('pin'));
        await refreshState();
        active='overview';
        renderApp();
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });
  }

  function overviewView() {
    const children = family?.children?.length || 0;
    return `
      <section class="hero">
        <div class="heroicon">📘</div>
        <div>
          <div class="eyebrow">Lokaler Arbeitsstand</div>
          <h2>${esc(family.name)}</h2>
          <p>Angemeldet als <b>${esc(session.name)}</b>. Familien- und Lerndaten liegen persistent im Browser und verwenden dasselbe Familienobjekt wie die native School-App.</p>
        </div>
      </section>
      <div class="cards">
        <article class="card"><div class="big">👨‍👩‍👧</div><h3>${children} Kinderprofile</h3><p>Stabile IDs, Klassenstufen und Lernziele.</p></article>
        <article class="card"><div class="big">📚</div><h3 id="currCount">Lehrpläne</h3><p>JONIVO-Vertrag mit Revision, SHA-256 und Rechtebeleg.</p></article>
        <article class="card"><div class="big">💾</div><h3>Lokale Datenbank</h3><p>IndexedDB im Browser. Kein flüchtiger Demo-Speicher.</p></article>
        <article class="card"><div class="big">🔄</div><h3>Abgleich vorbereitet</h3><p>Familien-Snapshots und lokale Änderungen landen im Sync-Outbox-Format.</p></article>
      </div>`;
  }

  function childrenView() {
    const adult = !!session.isAdult;
    return `
      <section class="panel">
        <div class="eyebrow">Familie · schema 1</div>
        <h2>Kinderprofile</h2>
        <div class="list">
          ${family.children.length ? family.children.map(c => `
            <article class="rowcard">
              <div><b>${esc(c.displayName)}</b><div class="muted">ID ${esc(c.id)} · Klasse ${c.formalGrade || '–'} → Ziel ${c.targetGrade || '–'} · ${esc(c.schoolType)}</div></div>
              ${adult ? `<button class="secondary setpin" data-id="${esc(c.id)}" data-name="${esc(c.displayName)}">PIN setzen</button>` : ''}
            </article>`).join('') : '<p>Noch keine Kinderprofile.</p>'}
        </div>
        ${adult ? `
        <hr>
        <h3>Kind hinzufügen</h3>
        <form id="childForm" class="form gridform">
          <label>Name<input name="displayName" required minlength="2"></label>
          <label>Aktuelle Klasse<input name="formalGrade" type="number" min="0" max="13" value="0"></label>
          <label>Zielklasse<input name="targetGrade" type="number" min="0" max="13" value="0"></label>
          <label>Schulart
            <select name="schoolType"><option>Nicht festgelegt</option><option>Grundschule</option><option>Oberschule</option><option>Gymnasium</option></select>
          </label>
          <label>Tagesziel Minuten<input name="dailyTargetMinutes" type="number" min="0" max="480" value="20"></label>
          <button class="primary" type="submit">Kind anlegen</button>
        </form>` : ''}
      </section>`;
  }

  function curriculumView() {
    const adult = !!session.isAdult;
    return `
      <section class="panel">
        <div class="eyebrow">Offline-Lehrplanbestand</div>
        <h2>Lehrpläne</h2>
        <p>Unterstützt den bestehenden JONIVO-Lehrplanvertrag: Manifest + JSON/JSONL-Inhalt, Paket-ID, Revision, SHA-256 und Rechtebeleg.</p>
        ${adult ? `
        <form id="currForm" class="form">
          <label>Unabhängig geprüfte Erlaubnis-/Lizenzreferenz<input name="permission" required maxlength="256"></label>
          <label>Manifest (.json)<input name="manifest" type="file" accept=".json,application/json" required></label>
          <label>Inhalt (.json oder .jsonl)<input name="payload" type="file" accept=".json,.jsonl,application/json" required></label>
          <button class="primary" type="submit">Lehrplanpaket prüfen und importieren</button>
        </form>
        <hr>` : ''}
        <div class="toolbar">
          <input id="currSearch" placeholder="Lehrplanbestand durchsuchen">
          <button class="secondary" id="searchButton">Suchen</button>
        </div>
        <div id="curricula" class="list"></div>
        <div id="searchResults" class="list"></div>
      </section>`;
  }

  function dataView() {
    return `
      <section class="panel">
        <div class="eyebrow">Windows-Abgleich vorbereitet</div>
        <h2>Daten & Abgleich</h2>
        <p>Das Austauschpaket enthält Familie, Lernstände/Versuche, Lehrplanmetadaten/-einträge und die lokale Sync-Outbox. <b>PINs und PIN-Hashes werden nicht exportiert.</b></p>
        <div class="actions">
          <button class="primary" id="exportData">JONIVO-Abgleichpaket exportieren</button>
          <label class="filebutton">Abgleichpaket importieren<input id="importData" type="file" accept=".json,application/json" hidden></label>
        </div>
        <div class="dbnote">
          Familien-ID: <b>${esc(family.id)}</b><br>
          Familienrevision: <b>${family.revision}</b><br>
          Format: <b>jonivo.school.web-sync.v1</b>
        </div>
      </section>`;
  }

  async function renderApp() {
    await refreshState();
    if (!family) return setupView();
    if (!session) return loginView();
    if (!session.isAdult && active === 'data') active = 'overview';

    let content = overviewView();
    if (active === 'children') content = childrenView();
    if (active === 'curriculum') content = curriculumView();
    if (active === 'data') content = dataView();
    root.innerHTML = shell(content);

    document.getElementById('logout')?.addEventListener('click', () => {
      D.signOut(); session = null; loginView();
    });
    document.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => {
      active = btn.dataset.page;
      renderApp();
    }));

    if (active === 'overview') {
      D.listCurricula().then(items => {
        const el=document.getElementById('currCount');
        if (el) el.textContent = items.length + ' Lehrplanpaket' + (items.length === 1 ? '' : 'e');
      });
    }

    if (active === 'children') wireChildren();
    if (active === 'curriculum') wireCurriculum();
    if (active === 'data') wireData();
  }

  function wireChildren() {
    document.getElementById('childForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        await D.addChild({
          displayName:f.get('displayName'),
          formalGrade:Number(f.get('formalGrade') || 0),
          targetGrade:Number(f.get('targetGrade') || 0),
          schoolType:f.get('schoolType'),
          federalState:'Sachsen',
          dailyTargetMinutes:Number(f.get('dailyTargetMinutes') || 20)
        });
        await refreshState();
        renderApp();
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });

    document.querySelectorAll('.setpin').forEach(btn => btn.addEventListener('click', async () => {
      const pin = prompt('Neue PIN für ' + btn.dataset.name + ' (4–64 Zeichen):');
      if (pin == null) return;
      const confirm = prompt('PIN wiederholen:');
      if (confirm == null) return;
      try {
        await D.setPersonPin(btn.dataset.id, pin, confirm);
        setMessage('PIN lokal gespeichert.', 'ok');
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    }));
  }

  async function loadCurricula() {
    const box = document.getElementById('curricula');
    if (!box) return;
    const items = await D.listCurricula();
    box.innerHTML = items.length ? items.map(x => `
      <article class="rowcard"><div><b>${esc(x.package_id)}</b>
      <div class="muted">Revision ${esc(x.revision)} · ${x.entries} Einträge · ${esc(x.source_date)}</div>
      <div class="muted">${esc(x.source_url)}</div></div></article>`).join('') : '<p>Noch keine Lehrplanpakete importiert.</p>';
  }

  function wireCurriculum() {
    loadCurricula().catch(err => setMessage(err.message || String(err), 'error'));

    document.getElementById('currForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const manifestFile = f.get('manifest');
      const payloadFile = f.get('payload');
      try {
        if (!(manifestFile instanceof File) || !(payloadFile instanceof File)) throw new Error('Manifest und Inhaltsdatei auswählen.');
        const result = await D.importCurriculum({
          manifestText: await manifestFile.text(),
          payloadText: await payloadFile.text(),
          permissionReference: f.get('permission'),
          jsonl: payloadFile.name.toLowerCase().endsWith('.jsonl')
        });
        setMessage(result.state === 'unchanged' ? 'Paket bereits unverändert vorhanden.' : `Lehrplanpaket importiert: ${result.entries} Einträge.`, 'ok');
        await loadCurricula();
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });

    document.getElementById('searchButton')?.addEventListener('click', async () => {
      try {
        const query=document.getElementById('currSearch').value;
        const results=await D.searchCurriculum(query);
        document.getElementById('searchResults').innerHTML = results.length ? results.map(x => `
          <article class="rowcard"><div><b>${esc(x.title)}</b><div class="muted">${esc(x.package_id)} · ${esc(x.entry_key)}</div><p>${esc(x.content)}</p></div></article>`).join('') : '<p>Keine Treffer.</p>';
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });
  }

  function download(name, text) {
    const blob = new Blob([text], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  function wireData() {
    document.getElementById('exportData')?.addEventListener('click', async () => {
      try {
        const text = await D.exportSyncBundle();
        download('jonivo-school-web-sync-' + new Date().toISOString().slice(0,10) + '.json', text);
        setMessage('Abgleichpaket erstellt.', 'ok');
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });
    document.getElementById('importData')?.addEventListener('change', async e => {
      const file=e.target.files?.[0]; if (!file) return;
      try {
        await D.importSyncBundle(await file.text());
        await refreshState();
        setMessage('Abgleichpaket importiert.', 'ok');
        renderApp();
      } catch (err) { setMessage(err.message || String(err), 'error'); }
    });
  }

  async function start() {
    try {
      await refreshState();
      if (!family) setupView();
      else if (!session) loginView();
      else renderApp();
    } catch (err) {
      root.innerHTML = '<main><div class="message error">' + esc(err.message || String(err)) + '</div></main>';
    }
  }

  start();
})();