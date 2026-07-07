/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 */
define(['N/search'], function (search) {

    function saveRecord(context) {
        var rec = context.currentRecord;
        var soClass = rec.getValue({ fieldId: 'class' });
        var lineCount = rec.getLineCount({ sublistId: 'item' });

        const SETUP_ITEM_ID = 231;

        if (!soClass) return true;

        var groupMap = {}; 
        // key = groupId, 
        // value = { totalQty, specialItemQty, minQty, maxQty, itemNames: [] }

        for (var i = 0; i < lineCount; i++) {
            var itemId = rec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            var qty = parseFloat(rec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
            var itemType = rec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
            var itemName = rec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i });
            var groupId = rec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_clusternum', line: i });

            if (!groupId) continue;

            // init group if not already
            if (!groupMap[groupId]) {
                groupMap[groupId] = { 
                    totalQty: 0, 
                    specialItemQty: 0,
                    minQty: 0, 
                    maxQty: 0, 
                    itemNames: [] 
                };
            }

            groupMap[groupId].itemNames.push(itemName);

            // Track special item (231) always, regardless of MOQ search
            if (parseInt(itemId, 10) == SETUP_ITEM_ID) {
                groupMap[groupId].specialItemQty += qty;
                continue;
            }

            if (itemType !== 'Assembly') continue;

            groupMap[groupId].totalQty += qty;

            // Lookup MOQ only if not yet set (any item in group can give MOQ)
            if (groupMap[groupId].minQty === 0 && groupMap[groupId].maxQty === 0) {
                var minQtyRec = search.create({
                    type: 'customrecord_bpc_sky_minimum_order_qty',
                    filters: [
                        ['custrecord_bpc_sky_dba', 'anyof', soClass],
                        'AND',
                        ['custrecord_bpc_sky_min_ord_item', 'anyof', itemId]
                    ],
                    columns: [
                        'custrecord_bpc_sky_min_ord_quant',
                        'custrecord_bpc_sky_min_ord_quant_2'
                    ]
                }).run().getRange({ start: 0, end: 1 });

                if (minQtyRec && minQtyRec.length > 0) {
                    groupMap[groupId].minQty = parseFloat(minQtyRec[0].getValue('custrecord_bpc_sky_min_ord_quant')) || 0;
                    groupMap[groupId].maxQty = parseFloat(minQtyRec[0].getValue('custrecord_bpc_sky_min_ord_quant_2')) || 0;
                }
            }
        }

        log.debug('groupMap', groupMap);

        var lowQtyGroups = [];

        for (var groupId in groupMap) {
            var obj = groupMap[groupId];

            if (obj.specialItemQty === 1) {
                // check against min qty
                if (obj.totalQty < obj.minQty) {
                    lowQtyGroups.push({
                        groupId: groupId,
                        itemNames: obj.itemNames.join(', '),
                        ordered: obj.totalQty,
                        required: obj.minQty
                    });
                }
            } else if (obj.specialItemQty > 1) {
                // check against multicolor (max qty)
                if (obj.totalQty < obj.maxQty) {
                    lowQtyGroups.push({
                        groupId: groupId,
                        itemNames: obj.itemNames.join(', '),
                        ordered: obj.totalQty,
                        required: obj.maxQty
                    });
                }
            }
        }

        log.debug('lowQtyGroups', lowQtyGroups);

        if (lowQtyGroups.length > 0) {
            var alertMsg = '⚠ Minimum order quantity not met for group(s):\n';
            lowQtyGroups.forEach(function (g) {
                alertMsg += 'Group ' + g.groupId + ' (' + g.itemNames +
                    ') - Ordered: ' + g.ordered +
                    ', Required: ' + g.required + '\n';
            });

            alert(alertMsg);
            return false; // block save
        }

        return true;
    }

    return {
        saveRecord: saveRecord
    };
});
