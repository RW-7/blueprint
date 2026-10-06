// JONIVO public web shell version 0.6.1.
// Uses the same browser data contract tracked in RW-7/jonivo-schule.
(() => {
  'use strict';

  const D = window.JonivoWebData;
  const root = document.getElementById('app');
  let active = 'overview';
  let family = null;
  let session = null;
  let authoringDraft = null;

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
        <div><h1>JONIVO Schule</h1><div class="sub">Web/PWA · 0.9.91</div></div>
        <div class="spacer"></div>
        ${session ? `<div class="user">${esc(session.name)} · ${esc(session.role)}</div><button class="ghost" id="logout">Abmelden</button>` : ''}
      </header>
      ${session ? `
      <nav class="tabs">
        <button data-page="overview" class="${active==='overview'?'active':''}">Übersicht</button>
        <button data-page="children" class="${active==='children'?'active':''}">Kinder</button>
        <button data-page="curriculum" class="${active==='curriculum'?'active':''}">Lehrpläne</button>
        ${adult ? `<button data-page="authoring" class="${active==='authoring'?'active':''}">Lernwerkstatt</button><button data-page="data" class="${active==='data'?'active':''}">Daten & Abgleich</button>` : ''}
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
    const adult=!!session.isAdult;
    const schoolTypes=adult && D.saxonySchoolTypes ? D.saxonySchoolTypes() : [];
    return `
      <section class="panel">
        <div class="eyebrow">Sächsischer Gesamtbestand</div>
        <h2>Lehrpläne</h2>
        <p>Die Lehrpläne werden direkt aus der offiziellen Lehrplandatenbank des Freistaates Sachsen eingelesen und anschließend lokal im JONIVO-Katalog gespeichert.</p>
        ${adult ? `
        <section class="subpanel">
          <h3>Von Sachsen-Webseite importieren</h3>
          <p>Importiert werden die öffentlich sichtbaren Lehrpläne der allgemeinbildenden Schulen und Förderschulen. Geschützte Zusatzmaterialien hinter der Schulportal-Anmeldung werden nicht übernommen.</p>
          <div id="bulkSummary" class="dbnote">Noch nicht gestartet.</div>
          <div class="schoolchips">${schoolTypes.map((name,index)=>`<span class="chip" id="schoolStatus${index}">○ ${esc(name)} · wartet</span>`).join('')}</div>
          <label class="reviewcheck">
            <input id="bulkConfirm" type="checkbox">
            Ich bestätige den Import der öffentlich sichtbaren Lehrplaninhalte aus der offiziellen sächsischen Lehrplandatenbank.
          </label>
          <button class="primary" id="bulkImport">Sachsen-Lehrpläne von der Webseite einlesen</button>
          <div id="bulkProgressWrap" hidden>
            <progress id="bulkProgress" max="1" value="0"></progress>
            <div id="bulkProgressText" class="muted"></div>
          </div>
        </section>
        <hr>
        <details>
          <summary><b>Erweiterter Import</b></summary>
          <p class="muted">Nur für bereits vorbereitete JONIVO-Pakete.</p>
          <label>JONIVO-Gesamtpaket (.json)<input id="catalogBundle" type="file" accept=".json,application/json"></label>
          <button class="secondary" id="bundleImport">Vorbereitetes Gesamtpaket einlesen</button>
          <hr>
          <form id="currForm" class="form">
            <label>Unabhängig geprüfte Erlaubnis-/Lizenzreferenz<input name="permission" required maxlength="256"></label>
            <label>Manifest (.json)<input name="manifest" type="file" accept=".json,application/json" required></label>
            <label>Inhalt (.json oder .jsonl)<input name="payload" type="file" accept=".json,.jsonl,application/json" required></label>
            <button class="secondary" type="submit">Einzelpaket importieren</button>
          </form>
        </details>
        <hr>` : ''}
        <div class="toolbar">
          <input id="currSearch" placeholder="Lehrplanbestand durchsuchen">
          <button class="secondary" id="searchButton">Suchen</button>
        </div>
        <div id="curricula" class="list"></div>
        <div id="searchResults" class="list"></div>
      </section>`;
  }

  function authoringView() {
    return `
      <section class="panel">
        <div class="eyebrow">Lehrplan → Lernvermittlung → Aufgaben</div>
        <h2>Lernwerkstatt</h2>
        <p>Hier wählst du einen importierten Lehrplaneintrag aus. Daraus wird ein <b>Entwurf</b> für Lernvermittlung und Aufgaben erstellt. Erst nach deiner Prüfung werden die Inhalte als JONIVO-Lernszene und Aufgabenvorlage freigegeben.</p>
        <div class="toolbar">
          <select id="entrySelect" style="flex:1;min-width:260px"></select>
          <button class="primary" id="generateDraft">Entwurf erzeugen</button>
        </div>
        <div id="authoringStatus" class="dbnote">Noch kein Lehrplaneintrag ausgewählt.</div>
        <div id="authoringEditor"></div>
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
    if (!session.isAdult && (active === 'data' || active === 'authoring')) active = 'overview';

    let content = overviewView();
    if (active === 'children') content = childrenView();
    if (active === 'curriculum') content = curriculumView();
    if (active === 'authoring') content = authoringView();
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
    if (active === 'authoring') wireAuthoring();
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
    const schoolTypes=D.saxonySchoolTypes ? D.saxonySchoolTypes() : [];
    loadCurricula().catch(err=>setMessage(err.message||String(err),'error'));

    document.getElementById('bulkImport')?.addEventListener('click', async()=>{
      if(document.getElementById('bulkConfirm')?.checked!==true){
        setMessage('Bitte die Quellenbestätigung für den Sachsen-Import setzen.','error');
        return;
      }
      const wrap=document.getElementById('bulkProgressWrap');
      const progress=document.getElementById('bulkProgress');
      const progressText=document.getElementById('bulkProgressText');
      const button=document.getElementById('bulkImport');
      try{
        wrap.hidden=false;
        progress.value=0;
        progress.max=1;
        schoolTypes.forEach((name,index)=>{
          const chip=document.getElementById('schoolStatus'+index);
          if(chip){chip.textContent='○ '+name+' · wartet';chip.dataset.state='waiting';}
        });
        const summary=document.getElementById('bulkSummary');
        if(summary) summary.innerHTML='<b>Sachsen-Inhaltsimport wird vorbereitet …</b>';
        button.disabled=true;

        const result=await D.importAllSaxonyCurricula({
          adultConfirmed:true,
          onProgress:(p)=>{
            const total=Math.max(1,Number(p.total||1));
            progress.max=total;
            progress.value=Math.min(total,Number(p.current||0));
            progressText.textContent=p.message||'Lehrplaninhalte werden von Sachsen.de gelesen und geparst …';

            const summary=document.getElementById('bulkSummary');
            if((p.phase==='discover'||p.phase==='discover-done'||p.phase==='discover-warning') && summary){
              summary.innerHTML='<b>Inhalte durchsuchen: '+Number(p.current||0)+' von '+total+'</b>'+
                (Number.isFinite(Number(p.found))?' · '+Number(p.found)+' Lehrpläne erkannt':'');
            } else if(p.phase==='prepare' && summary){
              summary.innerHTML='<b>Lehrpläne zuordnen: '+Number(p.current||0)+' von '+total+'</b>';
            }

            if(p.schoolType){
              const index=schoolTypes.indexOf(p.schoolType);
              const chip=index>=0?document.getElementById('schoolStatus'+index):null;
              if(chip){
                if(p.status==='waiting'){
                  chip.textContent='○ '+p.schoolType+' · wartet'; chip.dataset.state='waiting';
                }else if(p.status==='running'){
                  chip.textContent='⏳ '+p.schoolType+' · läuft'+(Number(p.found)>0?' ('+Number(p.found)+' Lehrpläne)':''); chip.dataset.state='running';
                }else if(p.status==='done'){
                  chip.textContent='✓ '+p.schoolType+' · fertig ('+Number(p.imported||p.found||0)+' Lehrpläne)'; chip.dataset.state='done';
                }else if(p.status==='empty'){
                  chip.textContent='— '+p.schoolType+' · keine Treffer'; chip.dataset.state='empty';
                }else if(p.status==='skipped'){
                  chip.textContent='⚠ '+p.schoolType+' · übersprungen'; chip.dataset.state='skipped';
                }
              }
            }
          }
        });

        const failed=result.failures?.length||0;
        const finalSummary=document.getElementById('bulkSummary');
        if(finalSummary) finalSummary.innerHTML='<b>Import abgeschlossen</b> · '+result.documentsImported+
          ' Lehrplandokumente · '+result.packagesInstalled+' Pakete neu'+
          (result.unchanged?' · '+result.unchanged+' unverändert':'')+
          (failed?' · '+failed+' Fehler':'');
        setMessage(
          `Sachsen-Inhaltsimport abgeschlossen: ${result.documentsImported} Lehrplandokumente, ${result.packagesInstalled} Pakete neu gespeichert${failed?' · '+failed+' Fehler':''}.`,
          failed?'info':'ok'
        );
        await loadCurricula();
      }catch(err){
        setMessage(err.message||String(err),'error');
      }finally{
        if(button) button.disabled=false;
      }
    });

    document.getElementById('bundleImport')?.addEventListener('click',async()=>{
      const file=document.getElementById('catalogBundle')?.files?.[0];
      if(!file){setMessage('Bitte zuerst ein vorbereitetes JONIVO-Gesamtpaket auswählen.','error');return;}
      try{
        const result=await D.importCurriculumBundle(await file.text());
        setMessage(`Gesamtpaket verarbeitet: ${result.installed} neu, ${result.unchanged} unverändert.`,result.failures?.length?'info':'ok');
        await loadCurricula();
      }catch(err){setMessage(err.message||String(err),'error');}
    });

    document.getElementById('currForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      const f=new FormData(e.currentTarget);
      const manifestFile=f.get('manifest');
      const payloadFile=f.get('payload');
      try{
        if(!(manifestFile instanceof File)||!(payloadFile instanceof File)) throw new Error('Manifest und Inhaltsdatei auswählen.');
        const result=await D.importCurriculum({
          manifestText:await manifestFile.text(),
          payloadText:await payloadFile.text(),
          permissionReference:f.get('permission'),
          jsonl:payloadFile.name.toLowerCase().endsWith('.jsonl')
        });
        setMessage(result.state==='unchanged'?'Paket bereits unverändert vorhanden.':`Lehrplanpaket importiert: ${result.entries} Einträge.`,'ok');
        await loadCurricula();
      }catch(err){setMessage(err.message||String(err),'error');}
    });

    document.getElementById('searchButton')?.addEventListener('click',async()=>{
      try{
        const query=document.getElementById('currSearch').value;
        const results=await D.searchCurriculum(query);
        document.getElementById('searchResults').innerHTML=results.length?results.map(x=>`
          <article class="rowcard"><div><b>${esc(x.title)}</b><div class="muted">${esc(x.package_id)} · ${esc(x.entry_key)}</div><p>${esc(x.content)}</p></div></article>`).join(''):'<p>Keine Treffer.</p>';
      }catch(err){setMessage(err.message||String(err),'error');}
    });
  }

  async function wireAuthoring() {
    const select=document.getElementById('entrySelect');
    const status=document.getElementById('authoringStatus');
    const editor=document.getElementById('authoringEditor');
    try {
      const entries=await D.listCurriculumEntries();
      select.innerHTML=entries.length
        ? '<option value="">Lehrplaneintrag auswählen …</option>'+entries.map(row =>
            `<option value="${esc(row.id)}">${esc(row.package_id)} · ${esc(row.title)}</option>`).join('')
        : '<option value="">Noch keine Lehrplaneinträge importiert</option>';
      if(!entries.length) status.textContent='Zuerst unter „Lehrpläne“ einen sächsischen Lehrplan importieren.';
    } catch(err) {
      setMessage(err.message || String(err),'error');
      return;
    }

    async function showDraft(draft) {
      authoringDraft=draft;
      const saved=await D.authoringStatus(draft.entry.id);
      status.innerHTML=`<b>${esc(draft.entry.title)}</b><br>${esc(draft.entry.package_id)} · ${esc(draft.entry.entry_key)}<br>
        Lernszene: <b>${saved.scene?'freigegeben':'noch nicht freigegeben'}</b> · Aufgaben: <b>${saved.templates.length}</b>`;
      editor.innerHTML=`
        <hr>
        <h3>Lernvermittlung</h3>
        <label>Avatar-Einstieg<textarea id="avatarLine" rows="2">${esc(draft.scene.avatarLine)}</textarea></label>
        <label>Kindgerechte Erklärung<textarea id="narration" rows="8">${esc(draft.scene.narration)}</textarea></label>
        <label>Beispiel<textarea id="example" rows="4">${esc(draft.scene.example)}</textarea></label>
        <label>Alternative Erklärung<textarea id="alternative" rows="6">${esc(draft.scene.alternative)}</textarea></label>
        <hr>
        <h3>Aufgabe</h3>
        <label>Frage<textarea id="taskPrompt" rows="3">${esc(draft.task.prompt)}</textarea></label>
        <label>Richtige Antwort<textarea id="taskSolution" rows="2">${esc(draft.task.solution)}</textarea></label>
        <label>Falschantwort 1<input id="wrong1" value="${esc(draft.task.distractors[0])}"></label>
        <label>Falschantwort 2<input id="wrong2" value="${esc(draft.task.distractors[1])}"></label>
        <label>Falschantwort 3<input id="wrong3" value="${esc(draft.task.distractors[2])}"></label>
        <label>Erklärung zur Lösung<textarea id="taskRationale" rows="4">${esc(draft.task.rationale)}</textarea></label>
        <label>Schwierigkeit<select id="difficulty"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
        <label class="reviewcheck"><input id="reviewedCheck" type="checkbox"> Ich habe Lernvermittlung, Aufgabe, Lösungen und Quelle fachlich geprüft.</label>
        <div class="actions">
          <button class="primary" id="saveAuthoring">Geprüfte Lernvermittlung + Aufgabe freigeben</button>
        </div>
        <div class="dbnote"><b>Wichtig:</b> Der automatisch erzeugte Text ist nur ein Entwurf. Ohne diese Prüfung wird nichts für das Kind freigegeben.</div>`;
      document.getElementById('saveAuthoring').addEventListener('click', async () => {
        if(!document.getElementById('reviewedCheck').checked) {
          setMessage('Bitte erst die fachliche Prüfung bestätigen.','error'); return;
        }
        try {
          await D.saveReviewedScene(draft.entry.id,{
            avatarLine:document.getElementById('avatarLine').value,
            narration:document.getElementById('narration').value,
            example:document.getElementById('example').value,
            alternative:document.getElementById('alternative').value
          });
          await D.saveReviewedVariant(draft.entry.id,{
            prompt:document.getElementById('taskPrompt').value,
            solution:document.getElementById('taskSolution').value,
            distractors:[
              document.getElementById('wrong1').value,
              document.getElementById('wrong2').value,
              document.getElementById('wrong3').value
            ],
            rationale:document.getElementById('taskRationale').value,
            difficulty:Number(document.getElementById('difficulty').value)
          });
          setMessage('Lernvermittlung und Aufgabe wurden geprüft gespeichert und für den Windows-Abgleich in die Outbox geschrieben.','ok');
          const fresh=await D.authoringStatus(draft.entry.id);
          status.innerHTML=`<b>${esc(draft.entry.title)}</b><br>Lernszene: <b>${fresh.scene?'freigegeben':'offen'}</b> · Aufgaben: <b>${fresh.templates.length}</b>`;
        } catch(err) { setMessage(err.message || String(err),'error'); }
      });
    }

    document.getElementById('generateDraft')?.addEventListener('click', async () => {
      const id=select.value;
      if(!id){setMessage('Bitte zuerst einen Lehrplaneintrag auswählen.','error');return;}
      try {
        const draft=await D.generateAuthoringDraft(id);
        await showDraft(draft);
      } catch(err){setMessage(err.message || String(err),'error');}
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