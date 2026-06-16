/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], function (currentRecord) {

    function pageInit() {
        try {
            bindPopupShell();
        } catch (e) {
            console.error('pageInit error', e);
        }
    }

    function bindPopupShell() {
        var overlay = document.getElementById('bpcInvGrpEmailOverlay');
        var closeBtn = document.getElementById('bpcInvGrpEmailClose');

        if (closeBtn && !closeBtn.__bpcBound) {
            closeBtn.__bpcBound = true;
            closeBtn.addEventListener('click', closeInvoiceGroupEmailPopup);
        }

        if (overlay && !overlay.__bpcBound) {
            overlay.__bpcBound = true;
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) {
                    closeInvoiceGroupEmailPopup();
                }
            });
        }

        if (!document.__bpcEscBound) {
            document.__bpcEscBound = true;
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    closeInvoiceGroupEmailPopup();
                }
            });
        }

        window.closeInvoiceGroupEmailPopup = closeInvoiceGroupEmailPopup;
                if (!window.__bpcInvGrpEmailMessageBound) {
            window.__bpcInvGrpEmailMessageBound = true;
            window.addEventListener('message', handleInvoiceGroupEmailMessage, false);
        }
    }

      function handleInvoiceGroupEmailMessage(e) {
        try {
            var data = e && e.data;
            if (!data || data.source !== 'bpc-invoice-group-email') {
                return;
            }

            var frame = document.getElementById('bpcInvGrpEmailFrame');
            if (frame && frame.contentWindow && e.source !== frame.contentWindow) {
                return;
            }

            if (data.action === 'close') {
                closeInvoiceGroupEmailPopup();

                if (data.refreshParent) {
                    window.setTimeout(function () {
                        window.location.reload();
                    }, 50);
                }
            }
        } catch (err) {
            console.error('invoice group email message error', err);
        }
    }

    function openInvoiceGroupEmailPopup() {
        try {
            bindPopupShell();

            var rec = currentRecord.get();
            var suiteletUrl = rec.getValue({
                fieldId: 'custpage_invgrp_email_sl'
            });

            var overlay = document.getElementById('bpcInvGrpEmailOverlay');
            var frame = document.getElementById('bpcInvGrpEmailFrame');

            if (!suiteletUrl) {
                alert('Email popup URL not present.');
                return;
            }

            if (!overlay || !frame) {
                alert('Popup container not found.');
                return;
            }

            frame.src = suiteletUrl;
            overlay.style.display = 'flex';

        } catch (e) {
            console.error('openInvoiceGroupEmailPopup error', e);
            alert('Could not open email popup.');
        }
    }

    function closeInvoiceGroupEmailPopup() {
        try {
            var overlay = document.getElementById('bpcInvGrpEmailOverlay');
            var frame = document.getElementById('bpcInvGrpEmailFrame');

            if (frame) {
                frame.src = 'about:blank';
            }
            if (overlay) {
                overlay.style.display = 'none';
            }
        } catch (e) {
            console.error('closeInvoiceGroupEmailPopup error', e);
        }
    }

    return {
        pageInit: pageInit,
        openInvoiceGroupEmailPopup: openInvoiceGroupEmailPopup
    };
});
