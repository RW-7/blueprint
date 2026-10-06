// JONIVO web data runtime version 0.1.0.
// Browser-local persistence compatible with the native LocalFamily schema.
// Credentials intentionally remain local to this browser and are never exported/synced.
(() => {
  'use strict';

  const DB_NAME = 'jonivo-schule-web';
  const DB_VERSION = 1;
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

  async function exportSyncBundle() {
    requireAdult();
    const family = await getFamily();
    const db = await openDb();
    const tx = db.transaction(['curriculum_packages','curriculum_entries','sync_outbox'], 'readonly');
    const packages = await requestResult(tx.objectStore('curriculum_packages').getAll());
    const entries = await requestResult(tx.objectStore('curriculum_entries').getAll());
    const outbox = await requestResult(tx.objectStore('sync_outbox').getAll());
    await txDone(tx);
    return JSON.stringify({
      format: 'jonivo.school.web-sync.v1',
      schema: 1,
      generated_at: new Date().toISOString(),
      family,
      curriculum_packages: packages,
      curriculum_entries: entries,
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
      const tx = db.transaction(['curriculum_packages','curriculum_entries'], 'readwrite');
      const ps = tx.objectStore('curriculum_packages');
      const es = tx.objectStore('curriculum_entries');
      for (const pkg of incoming.curriculum_packages) {
        if (pkg && typeof pkg.package_id === 'string' && typeof pkg.digest === 'string') ps.put(clone(pkg));
      }
      for (const row of incoming.curriculum_entries) {
        if (row && typeof row.id === 'string' && typeof row.package_id === 'string') es.put(clone(row));
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
    version: '0.1.0',
    isConfigured,
    setupFamily,
    getFamily,
    signIn,
    signOut,
    currentSession,
    addChild,
    setPersonPin,
    importCurriculum,
    listCurricula,
    searchCurriculum,
    exportSyncBundle,
    importSyncBundle,
    clearLocalData
  });
})();