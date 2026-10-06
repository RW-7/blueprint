// JONIVO web data runtime version 0.3.1.
// Browser-local persistence compatible with the native LocalFamily schema.
// Credentials intentionally remain local to this browser and are never exported/synced.
(() => {
  'use strict';

  const DB_NAME = 'jonivo-schule-web';
  const DB_VERSION = 3;
  const FAMILY_KEY = 'family-record';
  const CREDENTIAL_PREFIX = 'credential:';
  const SESSION_KEY = 'jonivo.school.web.session.v1';
  const PIN_ITERATIONS = 210000;

  let dbPromise;
  let session = null;

  const clone = (value) => JSON.parse(JSON.stringify(value));

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('curriculum_packages')) {
          db.createObjectStore('curriculum_packages', { keyPath: 'package_id' });
        }
        if (!db.objectStoreNames.contains('curriculum_entries')) {
          const store = db.createObjectStore('curriculum_entries', { keyPath: 'id' });
          store.createIndex('package_id', 'package_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('sync_outbox')) {
          const store = db.createObjectStore('sync_outbox', { keyPath: 'seq', autoIncrement: true });
          store.createIndex('family_id', 'family_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('lesson_scenes')) {
          const store = db.createObjectStore('lesson_scenes', { keyPath: 'id' });
          store.createIndex('entry_id', 'entry_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('variant_templates')) {
          const store = db.createObjectStore('variant_templates', { keyPath: 'id' });
          store.createIndex('entry_id', 'entry_id', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    return dbPromise;
  }

  async function kvGet(key) {
    const db = await openDb();
    const tx = db.transaction('kv', 'readonly');
    const value = await requestResult(tx.objectStore('kv').get(key));
    await txDone(tx);
    return value ? value.value : null;
  }

  async function kvPut(key, value) {
    const db = await openDb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value });
    await txDone(tx);
  }

  async function kvDelete(key) {
    const db = await openDb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    await txDone(tx);
  }

  function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return bytesToBase64Url(bytes);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function pinVerifier(pin, saltBytes) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PIN_ITERATIONS },
      keyMaterial,
      256
    );
    return new Uint8Array(bits);
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function makeCredential(pin) {
    if (typeof pin !== 'string' || pin.length < 4 || pin.length > 64) {
      throw new Error('PIN muss 4 bis 64 Zeichen lang sein.');
    }
    const salt = crypto.getRandomValues(new Uint8Array(24));
    const hash = await pinVerifier(pin, salt);
    return {
      format: 'jonivo.web.credential.v1',
      kdf: 'pbkdf2-sha256',
      iterations: PIN_ITERATIONS,
      salt: bytesToBase64(salt),
      pinHash: bytesToBase64(hash),
      failures: 0,
      lockedUntilEpochMs: 0
    };
  }

  async function checkCredential(key, pin) {
    const record = await kvGet(CREDENTIAL_PREFIX + key);
    if (!record || record.format !== 'jonivo.web.credential.v1') return false;
    const now = Date.now();
    if ((record.lockedUntilEpochMs || 0) > now) {
      throw new Error('Zu viele Versuche. Bitte später erneut versuchen.');
    }

    const failures = (record.failures || 0) + 1;
    record.failures = failures;
    if (failures >= 5) {
      record.lockedUntilEpochMs = now + 60000 * Math.pow(2, Math.min(failures - 5, 6));
    }
    await kvPut(CREDENTIAL_PREFIX + key, record);

    if (typeof pin !== 'string' || pin.length < 4 || pin.length > 64) return false;
    const actual = await pinVerifier(pin, base64ToBytes(record.salt));
    const ok = timingSafeEqual(actual, base64ToBytes(record.pinHash));
    if (ok) {
      record.failures = 0;
      record.lockedUntilEpochMs = 0;
      await kvPut(CREDENTIAL_PREFIX + key, record);
    }
    return ok;
  }

  function validateChild(child) {
    if (!child || typeof child !== 'object') throw new Error('Ungültiges Kinderprofil.');
    if (typeof child.id !== 'string' || !child.id) throw new Error('Kinder-ID fehlt.');
    if (typeof child.displayName !== 'string' || child.displayName.trim().length < 2) {
      throw new Error('Kindername ist ungültig.');
    }
    if (!Number.isInteger(child.dailyTargetMinutes) || child.dailyTargetMinutes < 0 || child.dailyTargetMinutes > 480) {
      throw new Error('Tagesziel ist ungültig.');
    }
    for (const key of ['formalGrade', 'targetGrade']) {
      if (!Number.isInteger(child[key]) || child[key] < 0 || child[key] > 13) {
        throw new Error('Klassenstufe ist ungültig.');
      }
    }
  }

  function validateFamily(family) {
    if (!family || typeof family !== 'object' || family.schema !== 1) {
      throw new Error('Nicht unterstützte Familiendaten.');
    }
    if (typeof family.id !== 'string' || !family.id ||
        typeof family.name !== 'string' || family.name.trim().length < 2 ||
        typeof family.administratorName !== 'string' || family.administratorName.trim().length < 2) {
      throw new Error('Unvollständige Familiendaten.');
    }
    if (!Array.isArray(family.children) || !Array.isArray(family.adults) ||
        !Array.isArray(family.attempts) || !Array.isArray(family.lessons)) {
      throw new Error('Familienlisten fehlen.');
    }
    family.children.forEach(validateChild);
    const ids = [
      ...family.children.map(x => x.id),
      ...family.adults.map(x => x.id)
    ];
    if (new Set(ids).size !== ids.length) throw new Error('Doppelte Familienidentität.');
    const names = [
      family.administratorName.toLowerCase(),
      ...family.children.map(x => x.displayName.toLowerCase()),
      ...family.adults.map(x => x.displayName.toLowerCase())
    ];
    if (new Set(names).size !== names.length) throw new Error('Doppelte Anzeigenamen.');
    if (!Number.isInteger(family.revision) || family.revision < 1) family.revision = 1;
    return family;
  }

  function normalizeChild(input) {
    const subjectNames = ['Mathematik','Deutsch','Englisch','Biologie','Physik','Chemie','Geografie','Geschichte'];
    const filterLevels = (raw) => {
      const out = {};
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          if (subjectNames.includes(key) && Number.isInteger(value) && value >= 0 && value <= 13) out[key] = value;
        }
      }
      return out;
    };
    return {
      id: input.id || randomId(),
      displayName: String(input.displayName || '').trim(),
      dailyTargetMinutes: Number.isInteger(input.dailyTargetMinutes) ? input.dailyTargetMinutes : 20,
      formalGrade: Number.isInteger(input.formalGrade) ? input.formalGrade : 0,
      targetGrade: Number.isInteger(input.targetGrade) ? input.targetGrade : 0,
      schoolType: String(input.schoolType || 'Nicht festgelegt'),
      federalState: String(input.federalState || 'Sachsen'),
      ...(Number.isInteger(input.birthYear) ? { birthYear: input.birthYear } : {}),
      ...(Number.isInteger(input.birthMonth) ? { birthMonth: input.birthMonth } : {}),
      subjectStarts: filterLevels(input.subjectStarts),
      subjectTargets: filterLevels(input.subjectTargets),
      accessSupports: input.accessSupports && typeof input.accessSupports === 'object' ? clone(input.accessSupports) : {},
      extraWorkingTimePercent: Number.isInteger(input.extraWorkingTimePercent) ? input.extraWorkingTimePercent : 0,
      learningBlockMinutes: Number.isInteger(input.learningBlockMinutes) ? input.learningBlockMinutes : 30,
      breakMinutes: Number.isInteger(input.breakMinutes) ? input.breakMinutes : 10,
      revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1
    };
  }

  async function saveFamily(family, operation = 'upsert') {
    validateFamily(family);
    await kvPut(FAMILY_KEY, clone(family));
    const db = await openDb();
    const tx = db.transaction('sync_outbox', 'readwrite');
    tx.objectStore('sync_outbox').add({
      family_id: family.id,
      app: 'school',
      entity_type: 'family_snapshot',
      entity_id: family.id,
      operation,
      payload: { family: clone(family) },
      created_at: new Date().toISOString()
    });
    await txDone(tx);
  }

  async function setupFamily({ familyName, adultName, pin, pinConfirmation }) {
    if (await kvGet(FAMILY_KEY)) throw new Error('Eine lokale Familie existiert bereits.');
    familyName = String(familyName || '').trim();
    adultName = String(adultName || '').trim();
    if (familyName.length < 2 || familyName.length > 80 || adultName.length < 2 || adultName.length > 80) {
      throw new Error('Namen müssen 2 bis 80 Zeichen lang sein.');
    }
    if (pin !== pinConfirmation) throw new Error('Die PIN-Bestätigung stimmt nicht überein.');
    const family = {
      schema: 1,
      id: randomId(),
      name: familyName,
      administratorName: adultName,
      children: [],
      adults: [],
      attempts: [],
      lessons: [],
      revision: 1
    };
    await kvPut(CREDENTIAL_PREFIX + family.id + '/adult', await makeCredential(pin));
    await saveFamily(family, 'create');
    return clone(family);
  }

  async function isConfigured() {
    return !!(await kvGet(FAMILY_KEY));
  }

  async function getFamily() {
    const family = await kvGet(FAMILY_KEY);
    return family ? clone(validateFamily(family)) : null;
  }

  async function signIn(name, pin) {
    const family = await getFamily();
    if (!family) throw new Error('Dieses Gerät ist noch keiner Familie zugeordnet.');
    const who = String(name || '').trim().toLowerCase();
    if (!who) throw new Error('Name eingeben.');

    if (who === family.administratorName.toLowerCase()) {
      if (!(await checkCredential(family.id + '/adult', pin))) throw new Error('Name oder PIN stimmt nicht.');
      session = { familyId: family.id, userId: family.id + '/adult', name: family.administratorName, role: 'admin', isAdult: true };
    } else {
      const adult = family.adults.find(a => a.active !== false && String(a.displayName).toLowerCase() === who);
      const child = family.children.find(c => String(c.displayName).toLowerCase() === who);
      const person = adult || child;
      if (!person) throw new Error('Name oder PIN stimmt nicht.');
      if (!(await checkCredential(person.id, pin))) throw new Error('Name oder PIN stimmt nicht.');
      session = {
        familyId: family.id,
        userId: person.id,
        name: person.displayName,
        role: adult ? (adult.role || 'adult') : 'child',
        isAdult: !!adult
      };
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return clone(session);
  }

  function currentSession() {
    if (session) return clone(session);
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch (_) {}
    return session ? clone(session) : null;
  }

  function requireAdult() {
    const s = currentSession();
    if (!s || !s.isAdult) throw new Error('Eltern-/Erwachsenen-Anmeldung erforderlich.');
    return s;
  }

  function signOut() {
    session = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function addChild(input) {
    requireAdult();
    const family = await getFamily();
    const child = normalizeChild(input || {});
    validateChild(child);
    const lower = child.displayName.toLowerCase();
    const names = [
      family.administratorName.toLowerCase(),
      ...family.children.map(x => x.displayName.toLowerCase()),
      ...family.adults.map(x => x.displayName.toLowerCase())
    ];
    if (names.includes(lower)) throw new Error('Dieser Name wird bereits verwendet.');
    family.children.push(child);
    family.revision += 1;
    await saveFamily(family, 'upsert');
    return clone(child);
  }

  async function setPersonPin(personId, pin, confirmation) {
    requireAdult();
    if (pin !== confirmation) throw new Error('Die PIN-Bestätigung stimmt nicht überein.');
    const family = await getFamily();
    if (personId !== family.id + '/adult' &&
        !family.children.some(x => x.id === personId) &&
        !family.adults.some(x => x.id === personId && x.active !== false)) {
      throw new Error('Unbekanntes Familienmitglied.');
    }
    await kvPut(CREDENTIAL_PREFIX + personId, await makeCredential(pin));
  }

  async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function assertExactKeys(obj, keys, label) {
    const actual = Object.keys(obj).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((x, i) => x !== expected[i])) {
      throw new Error(label + ' enthält unbekannte oder fehlende Felder.');
    }
  }

  function validateHttps(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Ungültige HTTPS-Quelle.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.pathname === '/') {
      throw new Error('Nur echte HTTPS-Quellen zulässig.');
    }
    return value;
  }

  function validateManifest(m, permission, payloadBytes) {
    assertExactKeys(m, [
      'contract_version','package_id','state','school_type','subject','grade','revision',
      'source_url','source_revision_date','payload_sha256','payload_bytes','replaces_sha256','rights'
    ], 'Manifest');
    if (m.contract_version !== 1 || m.state !== 'SN' || !Number.isInteger(m.grade) || m.grade < 1 || m.grade > 13) {
      throw new Error('Unbekannter Vertrag oder Lehrplanbereich.');
    }
    const scope = /^[a-z][a-z0-9_-]{1,63}$/;
    if (!scope.test(m.school_type) || !scope.test(m.subject) ||
        m.package_id !== `sn.${m.school_type}.${m.subject}.${m.grade}`) {
      throw new Error('Paketkennung passt nicht zum Geltungsbereich.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.revision)) throw new Error('Ungültige Revision.');
    validateHttps(m.source_url);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.source_revision_date)) throw new Error('Ungültiges Quelldatum.');
    if (!/^[0-9a-f]{64}$/.test(m.payload_sha256)) throw new Error('Ungültiger SHA-256.');
    if (!Number.isInteger(m.payload_bytes) || m.payload_bytes < 1 || m.payload_bytes !== payloadBytes.byteLength) {
      throw new Error('Dateilänge stimmt nicht mit Manifest überein.');
    }
    if (m.replaces_sha256 !== null && !/^[0-9a-f]{64}$/.test(m.replaces_sha256)) {
      throw new Error('Ungültiger Vorgänger-Hash.');
    }
    if (!m.rights || typeof m.rights !== 'object') throw new Error('Fehlender Rechtevertrag.');
    assertExactKeys(m.rights, [
      'rights_holder','license_id','permission_reference','approved_by',
      'approved_on','allow_offline_storage','allow_peer_transfer'
    ], 'Rechtevertrag');
    for (const key of ['rights_holder','license_id','permission_reference','approved_by']) {
      if (typeof m.rights[key] !== 'string' || !m.rights[key].trim()) throw new Error('Ungültiges Rechtefeld: ' + key);
    }
    if (m.rights.allow_offline_storage !== true || typeof m.rights.allow_peer_transfer !== 'boolean' ||
        permission !== m.rights.permission_reference) {
      throw new Error('Unabhängige Offline-Rechteprüfung fehlt oder passt nicht.');
    }
    return m;
  }

  function parseCurriculumEntries(payloadText, manifest, isJsonl) {
    const entries = [];
    if (isJsonl) {
      const lines = payloadText.split(/\r?\n/).filter(x => x.length > 0);
      if (!lines.length) throw new Error('Leeres JSONL-Paket.');
      const header = JSON.parse(lines.shift());
      assertExactKeys(header, ['format'], 'JSONL-Kopf');
      if (header.format !== 'jonivo.curriculum.jsonl') throw new Error('Ungültiger JSONL-Kopf.');
      for (const line of lines) entries.push(JSON.parse(line));
    } else {
      const data = JSON.parse(payloadText);
      assertExactKeys(data, ['format','entries'], 'Lehrplanpaket');
      if (data.format !== 'jonivo.curriculum.entries' || !Array.isArray(data.entries)) {
        throw new Error('Ungültiges kompaktes Lehrplanpaket.');
      }
      entries.push(...data.entries);
    }
    if (!entries.length) throw new Error('Lehrplanpaket enthält keine Einträge.');
    const seen = new Set();
    for (const item of entries) {
      assertExactKeys(item, ['key','title','text','source_url','permission_reference'], 'Lehrplaneintrag');
      if (typeof item.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.key) || seen.has(item.key)) {
        throw new Error('Doppelte oder ungültige Lehrplan-ID.');
      }
      seen.add(item.key);
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 256 ||
          typeof item.text !== 'string' || item.text.length > 8192 ||
          item.source_url !== manifest.source_url ||
          item.permission_reference !== manifest.rights.permission_reference) {
        throw new Error('Ungültiger oder unklar lizenzierter Lehrplaneintrag.');
      }
    }
    return entries;
  }

  async function importCurriculum({ manifestText, payloadText, permissionReference, jsonl = false }) {
    requireAdult();
    const manifest = JSON.parse(manifestText);
    const bytes = new TextEncoder().encode(payloadText);
    validateManifest(manifest, String(permissionReference || '').trim(), bytes);
    const digest = await sha256Hex(bytes);
    if (digest !== manifest.payload_sha256) throw new Error('SHA-256-Prüfung fehlgeschlagen.');
    const entries = parseCurriculumEntries(payloadText, manifest, jsonl);

    const db = await openDb();
    const readTx = db.transaction('curriculum_packages', 'readonly');
    const current = await requestResult(readTx.objectStore('curriculum_packages').get(manifest.package_id));
    await txDone(readTx);
    if (current) {
      if (current.digest === digest && current.revision === manifest.revision) return { state: 'unchanged', entries: current.entries };
      if (manifest.replaces_sha256 !== current.digest) throw new Error('Fremde oder widersprüchliche Revisionsfolge.');
    } else if (manifest.replaces_sha256 !== null) {
      throw new Error('Fehlende Vorgängerrevision.');
    }

    const tx = db.transaction(['curriculum_packages','curriculum_entries'], 'readwrite');
    const packageStore = tx.objectStore('curriculum_packages');
    const entryStore = tx.objectStore('curriculum_entries');
    if (current) {
      const index = entryStore.index('package_id');
      const cursorReq = index.openCursor(IDBKeyRange.only(manifest.package_id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    }
    packageStore.put({
      package_id: manifest.package_id,
      revision: manifest.revision,
      digest,
      manifest: clone(manifest),
      source_url: manifest.source_url,
      source_date: manifest.source_revision_date,
      permission_reference: manifest.rights.permission_reference,
      allow_peer: manifest.rights.allow_peer_transfer === true,
      entries: entries.length,
      installed_at: new Date().toISOString()
    });
    let position = 0;
    for (const item of entries) {
      entryStore.put({
        id: digest + ':' + item.key,
        package_id: manifest.package_id,
        digest,
        entry_key: item.key,
        title: item.title,
        content: item.text,
        source_url: item.source_url,
        position: position++
      });
    }
    await txDone(tx);
    return { state: 'installed', entries: entries.length, packageId: manifest.package_id };
  }

  async function listCurricula() {
    const db = await openDb();
    const tx = db.transaction('curriculum_packages', 'readonly');
    const items = await requestResult(tx.objectStore('curriculum_packages').getAll());
    await txDone(tx);
    return items.sort((a, b) => a.package_id.localeCompare(b.package_id)).map(clone);
  }

  async function searchCurriculum(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const db = await openDb();
    const tx = db.transaction('curriculum_entries', 'readonly');
    const all = await requestResult(tx.objectStore('curriculum_entries').getAll());
    await txDone(tx);
    return all.filter(row =>
      String(row.title).toLowerCase().includes(q) ||
      String(row.content).toLowerCase().includes(q)
    ).slice(0, 100).map(clone);
  }

  async function curriculumEntry(entryId) {
    const db = await openDb();
    const tx = db.transaction('curriculum_entries', 'readonly');
    const row = await requestResult(tx.objectStore('curriculum_entries').get(entryId));
    await txDone(tx);
    if (!row) throw new Error('Lehrplaneintrag nicht gefunden.');
    return clone(row);
  }

  async function listCurriculumEntries(packageId = null) {
    const db = await openDb();
    const tx = db.transaction('curriculum_entries', 'readonly');
    const store = tx.objectStore('curriculum_entries');
    let rows;
    if (packageId) {
      rows = await requestResult(store.index('package_id').getAll(IDBKeyRange.only(packageId)));
    } else {
      rows = await requestResult(store.getAll());
    }
    await txDone(tx);
    return rows.sort((a,b) =>
      String(a.package_id).localeCompare(String(b.package_id)) ||
      Number(a.position || 0) - Number(b.position || 0)
    ).map(clone);
  }

  function sourceTextToEntries(text, sourceUrl, permissionReference) {
    const clean = String(text || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line.length >= 12 && line.length <= 4000);
    const filtered = clean.filter(line =>
      !/^(LEHRPLAN-DATENBANK|Herausgeber|Suche nach|Materialien anzeigen|Anmeldung im Schulportal)/i.test(line)
    );
    if (!filtered.length) throw new Error('Aus der Quelle konnten keine Lehrplanabschnitte erkannt werden.');
    const entries = [];
    let position = 0;
    for (const line of filtered) {
      if (entries.length >= 2000) break;
      const title = line.length <= 180 ? line : line.slice(0, 177) + '…';
      entries.push({
        key: 'source.' + String(++position).padStart(4,'0'),
        title,
        text: line.slice(0, 8192),
        source_url: sourceUrl,
        permission_reference: permissionReference
      });
    }
    return entries;
  }

  async function importSaxonySource({
    sourceUrl, schoolType, subject, grade, revision, sourceDate,
    permissionReference, sourceText, allowPeerTransfer = false
  }) {
    requireAdult();
    const sessionNow = currentSession();
    const url = new URL(String(sourceUrl || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== 'www.schulportal.sachsen.de' ||
        !url.pathname.startsWith('/lplandb/')) {
      throw new Error('Als Sachsen-Quelle ist nur die offizielle Lehrplandatenbank zulässig.');
    }
    const slug = value => String(value || '').trim().toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
    const school = slug(schoolType), subj = slug(subject);
    const nGrade = Number(grade);
    if (!school || !subj || !Number.isInteger(nGrade) || nGrade < 0 || nGrade > 13) {
      throw new Error('Schulart, Fach und Klassenstufe prüfen.');
    }
    const rev = String(revision || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rev)) {
      throw new Error('Revision darf nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.');
    }
    const date = String(sourceDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Quellenstand als YYYY-MM-DD angeben.');
    const permission = String(permissionReference || '').trim();
    if (!permission || permission.length > 256) throw new Error('Rechte-/Freigabereferenz angeben.');
    const entries = sourceTextToEntries(sourceText, url.toString(), permission);
    const payload = JSON.stringify({format:'jonivo.curriculum.entries', entries});
    const bytes = new TextEncoder().encode(payload);
    const digest = await sha256Hex(bytes);
    const packageId = `sn.${school}.${subj}.${nGrade}`;

    const db = await openDb();
    const readTx = db.transaction('curriculum_packages', 'readonly');
    const previous = await requestResult(readTx.objectStore('curriculum_packages').get(packageId));
    await txDone(readTx);
    const manifest = {
      contract_version: 1,
      package_id: packageId,
      state: 'SN',
      school_type: school,
      subject: subj,
      grade: nGrade,
      revision: rev,
      source_url: url.toString(),
      source_revision_date: date,
      payload_sha256: digest,
      payload_bytes: bytes.byteLength,
      replaces_sha256: previous ? previous.digest : null,
      rights: {
        rights_holder: 'Freistaat Sachsen / Landesamt für Schule und Bildung',
        license_id: 'locally-reviewed-source-import',
        permission_reference: permission,
        approved_by: sessionNow?.userId || 'local-adult',
        approved_on: new Date().toISOString().slice(0,10),
        allow_offline_storage: true,
        allow_peer_transfer: allowPeerTransfer === true
      }
    };
    return importCurriculum({
      manifestText: JSON.stringify(manifest),
      payloadText: payload,
      permissionReference: permission,
      jsonl: false
    });
  }

  async function fetchSaxonySource(sourceUrl) {
    requireAdult();
    const url = new URL(String(sourceUrl || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== 'www.schulportal.sachsen.de' ||
        !url.pathname.startsWith('/lplandb/')) {
      throw new Error('Nur die offizielle sächsische Lehrplandatenbank kann direkt geladen werden.');
    }
    let response;
    try {
      response = await fetch(url.toString(), { credentials:'omit', redirect:'follow' });
    } catch (_) {
      throw new Error('Direktes Laden wurde vom Schulportal/Browser blockiert. Seite als HTML/Text speichern oder Text einfügen.');
    }
    if (!response.ok) throw new Error('Sachsen-Quelle konnte nicht geladen werden (' + response.status + ').');
    const text = await response.text();
    if (!text || text.length < 50) throw new Error('Sachsen-Quelle enthält keinen lesbaren Text.');
    return text;
  }


  const SAXONY_DISCOVERY_QUERIES = Object.freeze([
    'Grundschule',
    'Oberschule',
    'Gymnasium',
    'Gemeinschaftsschule',
    'Abendgymnasium',
    'Kolleg',
    'Schule mit dem Förderschwerpunkt Lernen',
    'Schule mit dem Förderschwerpunkt geistige Entwicklung',
    'Schule mit dem Förderschwerpunkt Sehen',
    'Schule mit dem Förderschwerpunkt Hören',
    'Schule mit dem Förderschwerpunkt Sprache',
    'Schule mit dem Förderschwerpunkt körperliche und motorische Entwicklung',
    'Schule mit dem Förderschwerpunkt emotionale und soziale Entwicklung',
  ]);

  const SAXONY_SCHOOL_TYPES = Object.freeze([
    'Grundschule',
    'Oberschule',
    'Gymnasium',
    'Gemeinschaftsschule',
    'Abendgymnasium',
    'Kolleg',
    'Schule mit dem Förderschwerpunkt Lernen',
    'Schule mit dem Förderschwerpunkt geistige Entwicklung',
    'Schule mit dem Förderschwerpunkt Sehen',
    'Schule mit dem Förderschwerpunkt Hören',
    'Schule mit dem Förderschwerpunkt Sprache',
    'Schule mit dem Förderschwerpunkt körperliche und motorische Entwicklung',
    'Schule mit dem Förderschwerpunkt emotionale und soziale Entwicklung',
  ]);

  function saxonyUrl(raw) {
    const url = new URL(raw, 'https://www.schulportal.sachsen.de/lplandb/');
    if (url.protocol !== 'https:' || url.hostname !== 'www.schulportal.sachsen.de' ||
        !url.pathname.startsWith('/lplandb/')) {
      throw new Error('Ungültige Sachsen-Lehrplanadresse.');
    }
    url.hash = '';
    return url;
  }

  async function fetchOfficialSaxonyHtml(rawUrl) {
    const url = saxonyUrl(rawUrl);
    let response;
    try {
      response = await fetch(url.toString(), {
        credentials: 'omit',
        redirect: 'follow',
        headers: { 'Accept': 'text/html,application/xhtml+xml' }
      });
    } catch (_) {
      throw new Error('Die offizielle Lehrplandatenbank blockiert den direkten Browserabruf.');
    }
    if (!response.ok) throw new Error('Sachsen-Lehrplan konnte nicht geladen werden (' + response.status + ').');
    const text = await response.text();
    if (!text || text.length < 100) throw new Error('Lehrplanseite enthält keinen lesbaren Inhalt.');
    return text;
  }

  function canonicalLehrplanLink(href, base) {
    try {
      const url = saxonyUrl(new URL(href, base).toString());
      if (url.pathname.includes('/lehrplan/file/')) return null;
      const direct = url.pathname.match(/\/lplandb\/lehrplan\/(\d+)/);
      const id = direct ? direct[1] : url.searchParams.get('lplanid');
      if (!id || !/^\d+$/.test(id)) return null;
      if (direct) return 'https://www.schulportal.sachsen.de/lplandb/lehrplan/' + id;
      const compact = new URL('https://www.schulportal.sachsen.de/lplandb/index.php');
      compact.searchParams.set('lplanid', id);
      const scope = url.searchParams.get('lplansc');
      if (scope) compact.searchParams.set('lplansc', scope);
      return compact.toString();
    } catch (_) {
      return null;
    }
  }

  function humanTextFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,nav,footer').forEach(node => node.remove());
    const text = (doc.body?.innerText || doc.body?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { doc, text };
  }

  function detectSchoolType(text, hint='') {
    const joined = (hint + '\n' + text).toLowerCase();
    const ordered = [
      'Schule mit dem Förderschwerpunkt körperliche und motorische Entwicklung',
      'Schule mit dem Förderschwerpunkt emotionale und soziale Entwicklung',
      'Schule mit dem Förderschwerpunkt geistige Entwicklung',
      'Schule mit dem Förderschwerpunkt Lernen',
      'Schule mit dem Förderschwerpunkt Sehen',
      'Schule mit dem Förderschwerpunkt Hören',
      'Schule mit dem Förderschwerpunkt Sprache',
      'Gemeinschaftsschule',
      'Abendgymnasium',
      'Grundschule',
      'Oberschule',
      'Gymnasium',
      'Kolleg',
    ];
    for (const name of ordered) {
      if (joined.includes(name.toLowerCase())) return name;
    }
    return hint && SAXONY_SCHOOL_TYPES.includes(hint) ? hint : 'Allgemeinbildende Schule';
  }

  function detectGrades(text) {
    const found = new Set();
    const patterns = [
      /Klassenstufe(?:n)?\s+(\d{1,2})(?:\s*(?:\/|–|-|bis)\s*(\d{1,2}))?/gi,
      /Klst\.?\s*(\d{1,2})(?:\s*(?:\/|–|-|bis)\s*(\d{1,2}))?/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) {
        const a = Number(match[1]), b = match[2] ? Number(match[2]) : a;
        if (a < 1 || a > 13 || b < 1 || b > 13) continue;
        const low = Math.min(a,b), high = Math.max(a,b);
        if (high-low <= 6) {
          for (let grade=low; grade<=high; grade++) found.add(grade);
        } else {
          found.add(a); found.add(b);
        }
      }
    }
    return found.size ? [...found].sort((a,b)=>a-b) : [0];
  }

  function detectRevision(text, url) {
    const years = [...text.matchAll(/(?:Überarbeitung\s+|Stand\s+|\b)(20\d{2}|19\d{2})\b/g)]
      .map(match => Number(match[1]))
      .filter(year => year >= 1990 && year <= 2035);
    const year = years.length ? Math.max(...years) : new Date().getFullYear();
    const parsed = new URL(url);
    const id = (parsed.pathname.match(/\/lehrplan\/(\d+)/) || [])[1] ||
      parsed.searchParams.get('lplanid') || 'source';
    return { revision: String(year) + '.' + id, date: String(year) + '-01-01' };
  }

  function detectSubject(title, text, schoolType, url) {
    const candidates = [
      String(title || '').replace(/^Lehrplan\s+/i,'').trim(),
      ...String(text || '').split('\n').slice(0,80).map(x=>x.trim()).filter(Boolean)
    ];
    const escapedSchool = schoolType.replace(/[.*+?^$()|[\]\\]/g,'\\  function firstSentence(text) {');
    for (let candidate of candidates) {
      candidate = candidate
        .replace(/^Lehrplan\s+/i,'')
        .replace(new RegExp('^' + escapedSchool + '\\s*','i'),'')
        .replace(/\s+(?:19|20)\d{2}(?:\s*,?\s*Überarbeitung\s+(?:19|20)\d{2})?.*$/i,'')
        .trim();
      if (candidate.length >= 2 && candidate.length <= 120 &&
          !/^(Teil|Inhaltsverzeichnis|Aufbau und Verbindlichkeit|Ziele und Aufgaben|Herausgeber)$/i.test(candidate)) {
        return candidate;
      }
    }
    const id=(new URL(url).pathname.match(/(\d+)$/)||[])[1]||'fach';
    return 'Lehrplan ' + id;
  }

  async function discoverSaxonyCatalog(onProgress) {
    requireAdult();
    const map = new Map();
    let queryIndex = 0;
    for (const query of SAXONY_DISCOVERY_QUERIES) {
      queryIndex++;
      onProgress?.({
        phase:'discover',
        current:queryIndex,
        total:SAXONY_DISCOVERY_QUERIES.length,
        message:'Suche ' + query
      });
      const search = new URL('https://www.schulportal.sachsen.de/lplandb/index.php');
      search.searchParams.set('aktion','searchText');
      search.searchParams.set('lplansearchfield',query);
      let html;
      try {
        html = await fetchOfficialSaxonyHtml(search.toString());
      } catch (error) {
        throw new Error('Gesamtimport konnte die Lehrplanliste nicht lesen: ' + error.message);
      }
      const parsed = humanTextFromHtml(html);
      for (const a of parsed.doc.querySelectorAll('a[href]')) {
        const href = canonicalLehrplanLink(a.getAttribute('href'), search.toString());
        if (!href) continue;
        const u = new URL(href);
        const key = (u.pathname.match(/\/lehrplan\/(\d+)/)||[])[1] || u.searchParams.get('lplanid');
        if (!key) continue;
        if (!map.has(key)) map.set(key, {
          id:key,
          url:href,
          hint:query,
          searchTitle:String(a.textContent || '').replace(/\s+/g,' ').trim()
        });
      }
    }
    return [...map.values()].sort((a,b)=>Number(a.id)-Number(b.id));
  }

  async function importAllSaxonyCurricula({adultConfirmed=false,onProgress}={}) {
    requireAdult();
    if (!adultConfirmed) throw new Error('Bitte die einmalige Quellen-/Rechteprüfung bestätigen.');
    const catalog = await discoverSaxonyCatalog(onProgress);
    if (!catalog.length) throw new Error('Keine offiziellen Sachsen-Lehrpläne gefunden.');
    let documents=0, packages=0, skipped=0, failures=[];
    for (let index=0; index<catalog.length; index++) {
      const item=catalog[index];
      onProgress?.({
        phase:'import',
        current:index+1,
        total:catalog.length,
        message:'Lade Lehrplan ' + (item.searchTitle || item.id)
      });
      try {
        const html=await fetchOfficialSaxonyHtml(item.url);
        const parsed=humanTextFromHtml(html);
        const pageTitle=(parsed.doc.querySelector('h1')?.textContent ||
          parsed.doc.querySelector('title')?.textContent ||
          item.searchTitle || '').replace(/\s+/g,' ').trim();
        const schoolType=detectSchoolType(parsed.text,item.hint);
        const subject=detectSubject(pageTitle,parsed.text,schoolType,item.url);
        const grades=detectGrades(parsed.text);
        const rev=detectRevision(parsed.text,item.url);
        const permission='official-public-saxony-lplandb:' + item.id;
        for (const grade of grades) {
          try {
            const result=await importSaxonySource({
              sourceUrl:item.url,
              schoolType,
              subject,
              grade,
              revision:rev.revision,
              sourceDate:rev.date,
              permissionReference:permission,
              sourceText:parsed.text,
              allowPeerTransfer:false
            });
            if (result.state==='installed') packages++;
            else skipped++;
          } catch (error) {
            failures.push({id:item.id,schoolType,subject,grade,error:String(error.message||error)});
          }
        }
        documents++;
      } catch (error) {
        failures.push({id:item.id,url:item.url,error:String(error.message||error)});
      }
    }
    onProgress?.({phase:'done',current:catalog.length,total:catalog.length,message:'Gesamtimport abgeschlossen'});
    return {
      documentsDiscovered: catalog.length,
      documentsImported: documents,
      packagesInstalled: packages,
      unchanged: skipped,
      failures: failures.slice(0,100)
    };
  }

  function firstSentence(text) {
    const value = String(text || '').replace(/\s+/g,' ').trim();
    const match = value.match(/^(.{20,500}?[.!?])(?:\s|$)/);
    return (match ? match[1] : value.slice(0,500)).trim();
  }

  async function generateAuthoringDraft(entryId) {
    requireAdult();
    const entry = await curriculumEntry(entryId);
    const all = await listCurriculumEntries(entry.package_id);
    const others = all.filter(row => row.id !== entry.id && String(row.title).trim() !== String(entry.title).trim());
    const distractors = [];
    for (const row of others) {
      const candidate = String(row.title || '').trim();
      if (candidate && candidate !== entry.title && !distractors.includes(candidate)) distractors.push(candidate);
      if (distractors.length === 3) break;
    }
    while (distractors.length < 3) {
      distractors.push(['Ein anderes Lernziel','Ein späteres Thema','Ein Wiederholungsthema'][distractors.length]);
    }
    const core = firstSentence(entry.content);
    return {
      entry: clone(entry),
      scene: {
        avatarLine: `Wir schauen uns jetzt „${entry.title}“ gemeinsam an.`,
        narration: `Heute geht es um „${entry.title}“. ${entry.content}`.slice(0,6000),
        example: `Orientiere dich an diesem Kerngedanken aus dem Lehrplan: ${core}`.slice(0,3000),
        alternative: `Noch einmal anders: Das Lernziel heißt „${entry.title}“. Arbeite den Inhalt Schritt für Schritt durch und prüfe anschließend, ob du den Kerngedanken in eigenen Worten erklären kannst. ${core}`.slice(0,6000)
      },
      task: {
        kind: 'fixed',
        prompt: `Welches Lernziel bearbeiten wir gerade?`,
        solution: String(entry.title).slice(0,1200),
        rationale: `Die Aufgabe gehört zum Lehrplaneintrag „${entry.title}“. ${core}`.slice(0,2000),
        distractors: distractors.map(x => String(x).slice(0,1200)),
        difficulty: 1,
        minimum: 2,
        maximum: 20,
        items: []
      }
    };
  }

  async function saveReviewedScene(entryId, fields) {
    const s = requireAdult();
    const family = await getFamily();
    const entry = await curriculumEntry(entryId);
    const narration = String(fields.narration || '').trim();
    const example = String(fields.example || '').trim();
    const alternative = String(fields.alternative || '').trim();
    const avatarLine = String(fields.avatarLine || '').trim();
    if (!narration || !example || !alternative || !avatarLine ||
        narration.length > 6000 || example.length > 3000 ||
        alternative.length > 6000 || avatarLine.length > 600) {
      throw new Error('Lernszene ist unvollständig oder zu lang.');
    }
    const reviewedHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([
      entry.digest, entry.entry_key, narration, example, alternative, avatarLine, entry.source_url
    ])));
    const now = new Date().toISOString();
    const row = {
      digest: entry.digest,
      entry_key: entry.entry_key,
      narration,
      example,
      alternative,
      avatar_line: avatarLine,
      source_url: entry.source_url,
      reviewed_by: family.id + '/adult',
      reviewed_at: now,
      reviewed_hash: reviewedHash,
      updated_at: now
    };
    const db = await openDb();
    const tx = db.transaction(['lesson_scenes','sync_outbox'], 'readwrite');
    tx.objectStore('lesson_scenes').put({
      id: family.id + ':' + entry.id,
      entry_id: entry.id,
      family_id: family.id,
      ...row
    });
    tx.objectStore('sync_outbox').add({
      family_id: family.id,
      app: 'school',
      entity_type: 'school_lesson_scene',
      entity_id: entry.id,
      operation: 'upsert',
      payload: { schema:1, family:family.id, rows:[row], next:0 },
      created_at: now,
      principal_id: s.userId
    });
    await txDone(tx);
    return clone(row);
  }

  async function saveReviewedVariant(entryId, fields) {
    const s = requireAdult();
    const family = await getFamily();
    const entry = await curriculumEntry(entryId);
    const kind = 'fixed';
    const prompt = String(fields.prompt || '').trim();
    const solution = String(fields.solution || '').trim();
    const rationale = String(fields.rationale || '').trim();
    const distractors = Array.isArray(fields.distractors) ? fields.distractors.map(x=>String(x).trim()) : [];
    const difficulty = Number(fields.difficulty || 1);
    const minimum = 2, maximum = 20, items = [];
    if (!prompt || !solution || !rationale || prompt.length>2000 || solution.length>1200 ||
        rationale.length>2000 || distractors.length!==3 ||
        distractors.some(x=>!x || x.length>1200) ||
        new Set(distractors).size!==3 || distractors.includes(solution) ||
        !Number.isInteger(difficulty) || difficulty<1 || difficulty>5) {
      throw new Error('Aufgabenvorlage ist unvollständig oder widersprüchlich.');
    }
    const templateHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([
      entry.digest, entry.entry_key, entry.source_url, kind, prompt, solution,
      rationale, distractors, difficulty, minimum, maximum, items
    ])));
    const now = new Date().toISOString();
    const row = {
      digest: entry.digest,
      entry_key: entry.entry_key,
      template_hash: templateHash,
      kind,
      prompt,
      solution,
      rationale,
      distractors_json: JSON.stringify(distractors),
      parameters_json: JSON.stringify({min:minimum,max:maximum,items}),
      difficulty,
      source_url: entry.source_url,
      reviewed_by: family.id + '/adult',
      reviewed_at: now
    };
    const db = await openDb();
    const tx = db.transaction(['variant_templates','sync_outbox'], 'readwrite');
    tx.objectStore('variant_templates').put({
      id: family.id + ':' + entry.id + ':' + templateHash,
      entry_id: entry.id,
      family_id: family.id,
      ...row
    });
    tx.objectStore('sync_outbox').add({
      family_id: family.id,
      app: 'school',
      entity_type: 'school_variant_template',
      entity_id: entry.id + ':' + templateHash,
      operation: 'upsert',
      payload: { schema:1, family:family.id, kind:'template', rows:[row], nextKind:0, nextOffset:0 },
      created_at: now,
      principal_id: s.userId
    });
    await txDone(tx);
    return clone(row);
  }

  async function authoringStatus(entryId) {
    const family = await getFamily();
    if (!family) return {scene:null, templates:[]};
    const db = await openDb();
    const tx = db.transaction(['lesson_scenes','variant_templates'], 'readonly');
    const scene = await requestResult(tx.objectStore('lesson_scenes').get(family.id + ':' + entryId));
    const templates = await requestResult(tx.objectStore('variant_templates').index('entry_id').getAll(IDBKeyRange.only(entryId)));
    await txDone(tx);
    return {scene: scene ? clone(scene) : null, templates: templates.map(clone)};
  }

  async function exportSyncBundle() {
    requireAdult();
    const family = await getFamily();
    const db = await openDb();
    const tx = db.transaction(['curriculum_packages','curriculum_entries','lesson_scenes','variant_templates','sync_outbox'], 'readonly');
    const packages = await requestResult(tx.objectStore('curriculum_packages').getAll());
    const entries = await requestResult(tx.objectStore('curriculum_entries').getAll());
    const scenes = await requestResult(tx.objectStore('lesson_scenes').getAll());
    const variants = await requestResult(tx.objectStore('variant_templates').getAll());
    const outbox = await requestResult(tx.objectStore('sync_outbox').getAll());
    await txDone(tx);
    return JSON.stringify({
      format: 'jonivo.school.web-sync.v1',
      schema: 1,
      generated_at: new Date().toISOString(),
      family,
      curriculum_packages: packages,
      curriculum_entries: entries,
      school_lesson_scenes: scenes,
      school_variant_templates: variants,
      outbox
    }, null, 2);
  }

  async function importSyncBundle(text) {
    requireAdult();
    const incoming = JSON.parse(text);
    if (!incoming || incoming.format !== 'jonivo.school.web-sync.v1' || incoming.schema !== 1) {
      throw new Error('Unbekanntes JONIVO-Austauschformat.');
    }
    const incomingFamily = validateFamily(clone(incoming.family));
    const local = await getFamily();
    if (local && local.id !== incomingFamily.id) throw new Error('Fremde Familie wird nicht überschrieben.');
    if (!local || incomingFamily.revision >= local.revision) {
      await saveFamily(incomingFamily, 'import');
    }

    if (Array.isArray(incoming.curriculum_packages) && Array.isArray(incoming.curriculum_entries)) {
      const db = await openDb();
      const tx = db.transaction(['curriculum_packages','curriculum_entries','lesson_scenes','variant_templates'], 'readwrite');
      const ps = tx.objectStore('curriculum_packages');
      const es = tx.objectStore('curriculum_entries');
      const ss = tx.objectStore('lesson_scenes');
      const vs = tx.objectStore('variant_templates');
      for (const pkg of incoming.curriculum_packages) {
        if (pkg && typeof pkg.package_id === 'string' && typeof pkg.digest === 'string') ps.put(clone(pkg));
      }
      for (const row of incoming.curriculum_entries) {
        if (row && typeof row.id === 'string' && typeof row.package_id === 'string') es.put(clone(row));
      }
      if (Array.isArray(incoming.school_lesson_scenes)) {
        for (const row of incoming.school_lesson_scenes) {
          if (row && typeof row.id === 'string' && typeof row.entry_id === 'string') ss.put(clone(row));
        }
      }
      if (Array.isArray(incoming.school_variant_templates)) {
        for (const row of incoming.school_variant_templates) {
          if (row && typeof row.id === 'string' && typeof row.entry_id === 'string') vs.put(clone(row));
        }
      }
      await txDone(tx);
    }
    return { family: incomingFamily.id };
  }

  async function clearLocalData() {
    requireAdult();
    const db = await openDb();
    db.close();
    dbPromise = null;
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Datenbank ist noch geöffnet.'));
    });
    signOut();
  }

  window.JonivoWebData = Object.freeze({
    version: '0.3.0',
    isConfigured,
    setupFamily,
    getFamily,
    signIn,
    signOut,
    currentSession,
    addChild,
    setPersonPin,
    importCurriculum,
    importSaxonySource,
    fetchSaxonySource,
    discoverSaxonyCatalog,
    importAllSaxonyCurricula,
    saxonySchoolTypes: () => [...SAXONY_SCHOOL_TYPES],
    listCurricula,
    listCurriculumEntries,
    searchCurriculum,
    generateAuthoringDraft,
    saveReviewedScene,
    saveReviewedVariant,
    authoringStatus,
    exportSyncBundle,
    importSyncBundle,
    clearLocalData
  });
})();