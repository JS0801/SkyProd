/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define([], function () {

  var STATE = {
    customers: [],
    templates: [],
    employees: [],
    preMerged: {},
    recordId: '',
    recordType: 'invoicegroup',
    pickedFiles: []
  };

  function pageInit(context) {
    try {
      var rec = context.currentRecord;

      STATE.customers = parseJson(rec.getValue('custpage_email_customers'), []);
      STATE.employees = parseJson(rec.getValue('custpage_email_employees'), []);
      STATE.templates = parseJson(rec.getValue('custpage_email_templates'), []); 
      STATE.preMerged = parseJson(rec.getValue('custpage_email_premerged'), {});
      STATE.recordId = String(rec.getValue('custpage_email_recordid') || '');
      STATE.recordType = String(rec.getValue('custpage_email_recordtype') || 'invoicegroup');

      initUi();
    } catch (e) {
      console.error('pageInit error', e);
    }
  }

  function initUi() {
    populateEmployees();
    populateRecipients();
    populateTemplates();
    seedPrimaryRecipient();
    bindEvents();
  }

  function bindEvents() {
    bind('nsCloseTop', 'click', closePopup);
    bind('nsCloseBottom', 'click', closePopup);
    bind('nsSendTop', 'click', sendEmail);
    bind('nsSendBottom', 'click', sendEmail);
    bind('nsAddRecipientBtn', 'click', addRecipientFromInput);
    bind('nsRemoveRecipientsBtn', 'click', removeSelectedRecipients);
    bind('nsChooseFilesBtn', 'click', openFilePicker);
    bind('nsRemoveAttachmentsBtn', 'click', removeSelectedAttachments);

    var recCheckAll = document.getElementById('nsRecCheckAll');
    if (recCheckAll) {
      recCheckAll.addEventListener('change', function () {
        toggleAll('#nsRecTable tbody input[type="checkbox"]', recCheckAll.checked);
      });
    }

    var attCheckAll = document.getElementById('nsAttCheckAll');
    if (attCheckAll) {
      attCheckAll.addEventListener('change', function () {
        toggleAll('#nsAttTable tbody input[type="checkbox"]', attCheckAll.checked);
      });
    }

    var tabs = document.querySelectorAll('.ns-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        switchTab(this.getAttribute('data-tab'));
      });
    }

    var recipientSel = document.getElementById('nsRecipientSel');
    if (recipientSel) {
      recipientSel.addEventListener('change', function () {
        var emailField = document.getElementById('nsEmailTo');
        if (emailField) {
          emailField.value = this.value || '';
          emailField.focus();
        }
      });
    }

    var tplSel = document.getElementById('nsTpl');
    if (tplSel) {
      tplSel.addEventListener('change', function () {
        applyTemplate(this.value);
      });
    }

    var filePicker = document.getElementById('nsFilePicker');
    if (filePicker) {
      filePicker.addEventListener('change', function (e) {
        var files = [];
        try {
          files = Array.prototype.slice.call(e.target.files || []);
        } catch (err) {
          files = [];
        }
        readAndAppendFiles(files, 0);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closePopup();
      }
    });
  }

  function bind(id, eventName, fn) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener(eventName, fn);
    }
  }

  function populateEmployees() {
    var sel = document.getElementById('nsEmployeeSel');
    if (!sel) return;

    clearOptions(sel);

    for (var i = 0; i < STATE.employees.length; i++) {
      var emp = STATE.employees[i];
      var opt = document.createElement('option');
      opt.value = String(emp.id || '');
      opt.textContent = String(emp.name || '') + (emp.email ? ' (' + emp.email + ')' : '');
      if (emp.default === true) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function populateRecipients() {
    var sel = document.getElementById('nsRecipientSel');
    if (!sel) return;

    clearOptions(sel);

    var first = document.createElement('option');
    first.value = '';
    first.textContent = '- Select -';
    sel.appendChild(first);

    for (var i = 0; i < STATE.customers.length; i++) {
      var c = STATE.customers[i];
      var opt = document.createElement('option');
      opt.value = String(c.email || '');
      opt.textContent = String(c.name || '');
      sel.appendChild(opt);
    }
  }

  function populateTemplates() {
    var sel = document.getElementById('nsTpl');
    if (!sel) return;

    clearOptions(sel);

    var first = document.createElement('option');
    first.value = '';
    first.textContent = '- Select -';
    sel.appendChild(first);

    for (var i = 0; i < STATE.templates.length; i++) {
      var t = STATE.templates[i];
      var opt = document.createElement('option');
      opt.value = String(t.id || '');
      opt.textContent = String(t.name || '');
      sel.appendChild(opt);
    }
  }

  function seedPrimaryRecipient() {
    if (!STATE.customers || !STATE.customers.length) return;

    var first = null;
    for (var i = 0; i < STATE.customers.length; i++) {
      if (STATE.customers[i].email) {
        first = STATE.customers[i];
        break;
      }
    }
    if (!first) return;

    var emailInput = document.getElementById('nsEmailTo');
    if (emailInput) {
      emailInput.value = first.email;
    }

    addRecipientRow(first.email, 'TO');
  }

function applyTemplate(templateId) {
    var subjectEl = document.getElementById('nsSubject');
    var bodyEl = document.getElementById('nsBody');

    if (!templateId) {
        if (subjectEl) subjectEl.value = '';
        if (bodyEl) bodyEl.innerHTML = '';
        return;
    }

    // Serve from cache if this template was already merged this session
    var cached = STATE.preMerged[String(templateId)];
    if (cached) {
        if (subjectEl) subjectEl.value = cached.subject || '';
        if (bodyEl) bodyEl.innerHTML = cached.body || '';
        return;
    }

    var url = window.location.pathname + window.location.search +
              '&action=merge&templateid=' + encodeURIComponent(templateId);

    showLoader('Loading template...');
    fetch(url, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (entry) {
            entry = entry || { subject: '', body: '' };
            STATE.preMerged[String(templateId)] = entry; // cache for re-selection
            if (subjectEl) subjectEl.value = entry.subject || '';
            if (bodyEl) bodyEl.innerHTML = entry.body || '';
        })
        .catch(function (err) {
            console.error('template merge fetch error', err);
            alert('Could not load template.');
        })
        .finally(function () {
            hideLoader();
        });
}

  function switchTab(tabName) {
    var tabs = document.querySelectorAll('.ns-tab');
    var panels = document.querySelectorAll('.ns-panel');
    var i;

    for (i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    for (i = 0; i < panels.length; i++) panels[i].classList.remove('active');

    var tab = document.querySelector('.ns-tab[data-tab="' + tabName + '"]');
    var panel = document.getElementById('panel-' + tabName);

    if (tab) tab.classList.add('active');
    if (panel) panel.classList.add('active');
  }

  function addRecipientFromInput() {
    var emailField = document.getElementById('nsEmailTo');
    var roleField = document.getElementById('nsAddRecRole');
    var email = trim(emailField && emailField.value);
    var role = roleField ? roleField.value : 'TO';

    if (!email) {
      alert('Please enter an email address.');
      return;
    }

    if (!isEmail(email)) {
      alert('Please enter a valid email address.');
      return;
    }

    if (recipientExists(email)) {
      alert('This recipient is already added.');
      return;
    }

    addRecipientRow(email, role);
    emailField.value = '';
  }

  function addRecipientRow(email, role) {
    var tbody = document.querySelector('#nsRecTable tbody');
    if (!tbody) return;

    var tr = document.createElement('tr');
    tr.setAttribute('data-email', email);
    tr.setAttribute('data-role', role);

    tr.innerHTML =
      '<td><input type="checkbox" /></td>' +
      '<td>' + escapeHtml(email) + '</td>' +
      '<td>' + (role === 'TO' ? '&#10004;' : '') + '</td>' +
      '<td>' + (role === 'CC' ? '&#10004;' : '') + '</td>' +
      '<td>' + (role === 'BCC' ? '&#10004;' : '') + '</td>';

    tbody.appendChild(tr);
  }

  function recipientExists(email) {
    var rows = document.querySelectorAll('#nsRecTable tbody tr');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-email') || '').toLowerCase() === String(email).toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  function removeSelectedRecipients() {
    var rows = document.querySelectorAll('#nsRecTable tbody tr');
    for (var i = rows.length - 1; i >= 0; i--) {
      var cb = rows[i].querySelector('input[type="checkbox"]');
      if (cb && cb.checked) {
        rows[i].parentNode.removeChild(rows[i]);
      }
    }
  }

  function openFilePicker() {
    var fp = document.getElementById('nsFilePicker');
    if (!fp) return;
    fp.value = '';
    fp.click();
  }

  function readAndAppendFiles(files, index) {
    if (!files || index >= files.length) return;

    var f = files[index];
    if (f.size > 15 * 1024 * 1024) {
      alert('Skipping "' + f.name + '" because file is over 15 MB.');
      readAndAppendFiles(files, index + 1);
      return;
    }

    var reader = new FileReader();
    reader.onload = function (ev) {
      var entry = {
        name: f.name,
        type: f.type || 'application/octet-stream',
        size: f.size || 0,
        lastModified: f.lastModified || new Date().getTime(),
        dataUrl: String(ev.target.result || '')
      };

      STATE.pickedFiles.push(entry);
      appendAttachmentRow(entry);
      readAndAppendFiles(files, index + 1);
    };
    reader.onerror = function () {
      alert('Could not read file: ' + f.name);
      readAndAppendFiles(files, index + 1);
    };
    reader.readAsDataURL(f);
  }

  function appendAttachmentRow(fileEntry) {
    var tbody = document.querySelector('#nsAttTable tbody');
    if (!tbody) return;

    var tr = document.createElement('tr');
    tr.setAttribute('data-key', buildFileKey(fileEntry));

    tr.innerHTML =
      '<td><input type="checkbox" /></td>' +
      '<td>' + escapeHtml(fileEntry.name) + '</td>' +
      '<td>' + Math.round((fileEntry.size || 0) / 1024) + '</td>' +
      '<td>' + escapeHtml(new Date(fileEntry.lastModified).toLocaleString()) + '</td>' +
      '<td>' + escapeHtml(fileEntry.type || '') + '</td>';

    tbody.appendChild(tr);
  }

  function removeSelectedAttachments() {
    var rows = document.querySelectorAll('#nsAttTable tbody tr');
    var removeMap = {};
    var i;

    for (i = rows.length - 1; i >= 0; i--) {
      var cb = rows[i].querySelector('input[type="checkbox"]');
      if (cb && cb.checked) {
        removeMap[String(rows[i].getAttribute('data-key') || '')] = true;
        rows[i].parentNode.removeChild(rows[i]);
      }
    }

    var keep = [];
    for (i = 0; i < STATE.pickedFiles.length; i++) {
      if (!removeMap[buildFileKey(STATE.pickedFiles[i])]) {
        keep.push(STATE.pickedFiles[i]);
      }
    }
    STATE.pickedFiles = keep;
  }

  function buildFileKey(fileEntry) {
    return String(fileEntry.name || '') + '|' + String(fileEntry.size || 0) + '|' + String(fileEntry.lastModified || 0);
  }

  function toggleAll(selector, checked) {
    var boxes = document.querySelectorAll(selector);
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = !!checked;
    }
  }

  function collectRecipients() {
    var rows = document.querySelectorAll('#nsRecTable tbody tr');
    var out = [];

    for (var i = 0; i < rows.length; i++) {
      var role = String(rows[i].getAttribute('data-role') || 'TO');
      out.push({
        email: String(rows[i].getAttribute('data-email') || ''),
        to: role === 'TO',
        cc: role === 'CC',
        bcc: role === 'BCC'
      });
    }

    return out;
  }

  function collectAttachments() {
    var arr = [];
    for (var i = 0; i < STATE.pickedFiles.length; i++) {
      var f = STATE.pickedFiles[i];
      var idx = String(f.dataUrl || '').indexOf('base64,');
      var b64 = idx > -1 ? f.dataUrl.substring(idx + 7) : '';

      arr.push({
        name: f.name,
        type: f.type || 'application/octet-stream',
        size: f.size || 0,
        base64: b64
      });
    }
    return arr;
  }

  function sendEmail() {
    try {
      var authorEl = document.getElementById('nsEmployeeSel');
      var subjectEl = document.getElementById('nsSubject');
      var bodyEl = document.getElementById('nsBody');
      var incTxnEl = document.getElementById('nsIncTxn');

      var authorId = Number(authorEl && authorEl.value || 0);
      var subject = trim(subjectEl && subjectEl.value);
      var bodyHtml = bodyEl ? bodyEl.innerHTML : '';
      var recipients = collectRecipients();
      var attachments = collectAttachments();
      var includeTransaction = incTxnEl ? !!incTxnEl.checked : false;

      if (!authorId) {
        alert('Please select an Author.');
        switchTab('recipients');
        return;
      }

      if (!recipients.length) {
        alert('Please add at least one recipient.');
        switchTab('recipients');
        return;
      }

      if (!subject) {
        alert('Please enter a subject.');
        switchTab('message');
        return;
      }

      showLoader('Sending email...');

      var payload = {
        author: authorId,
        recordId: STATE.recordId,
        recordType: STATE.recordType,
        subject: subject,
        body: bodyHtml,
        recipients: recipients,
        includeTransaction: includeTransaction,
        attachments: attachments
      };

var form = document.createElement('form');
form.method = 'POST';
form.action = window.location.href;
form.style.display = 'none';

var payloadInput = document.createElement('input');
payloadInput.type = 'hidden';
payloadInput.name = 'custpage_email_payload';
payloadInput.value = JSON.stringify(payload);

form.appendChild(payloadInput);
document.body.appendChild(form);
form.submit();

    } catch (e) {
      hideLoader();
      console.error('sendEmail fatal', e);
      alert('Unexpected error. Please check logs.');
    }
  }

  function closePopup(refreshParent) {
    try {
      if (window.parent && typeof window.parent.closeInvoiceGroupEmailPopup === 'function') {
        window.parent.closeInvoiceGroupEmailPopup();
        if (refreshParent) {
          try {
            window.parent.location.reload();
          } catch (e1) {}
        }
      }
    } catch (e) {
      console.error('closePopup error', e);
    }
  }

  function showLoader(text) {
    var overlay = document.getElementById('nsEmailLoaderOverlay');
    var txt = document.getElementById('nsEmailLoaderText');
    if (txt) txt.textContent = text || 'Working...';
    if (overlay) overlay.style.display = 'flex';
  }

  function hideLoader() {
    var overlay = document.getElementById('nsEmailLoaderOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  function clearOptions(sel) {
    while (sel.options.length) {
      sel.remove(0);
    }
  }

  function parseJson(str, fallback) {
    try {
      return JSON.parse(str || '');
    } catch (e) {
      return fallback;
    }
  }

  function trim(v) {
    return String(v || '').replace(/^\s+|\s+$/g, '');
  }

  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
  }

  function stringifyMessage(msg) {
    if (typeof msg === 'string') return msg;
    try {
      return JSON.stringify(msg);
    } catch (e) {
      return String(msg);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    pageInit: pageInit
  };
});
