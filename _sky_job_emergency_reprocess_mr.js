/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Emergency Reprocess Map/Reduce
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggers (either queues the parent SO for full reprocess):
 *   • Sales Order checkbox:  custbody_sky_job_error       = true
 *   • Job record checkbox:   custrecord_sky_job_error     = true
 *
 * Governance strategy — work is split across stages so no single task
 * exceeds the 10,000 unit limit:
 *   getInputData → collect flagged SO IDs
 *   map          → per SO: read lines, build job structure, emit one entry per job (lightweight)
 *   reduce       → per job: routing searches, run-rate lookups, record creates/updates,
 *                  impressions fix (each job gets its own 10,000 unit budget)
 *   summarize    → uncheck error flags on all processed SOs & jobs
 * ─────────────────────────────────────────────────────────────────────────────
 */
define(['N/record', 'N/search', 'N/log', 'N/format'], function (record, search, log, format) {

    // =========================================================================
    // GET INPUT DATA
    // Collect unique SO IDs from both triggers
    // =========================================================================
    function getInputData() {
        var soIds = {};

        // Trigger 1: Sales Orders with error flag
        search.create({
            type: 'salesorder',
            filters: [['custbody_sky_job_error', 'is', 'T']],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function (r) {
            soIds[r.id] = true;
            return true;
        });

        // Trigger 2: Jobs with error flag → resolve to their SO
        search.create({
            type: 'customrecord_sky_job',
            filters: [['custrecord_sky_job_error', 'is', 'T']],
            columns: [search.createColumn({ name: 'custrecord_sky_sales_order' })]
        }).run().each(function (r) {
            var soId = r.getValue('custrecord_sky_sales_order');
            if (soId) soIds[soId] = true;
            return true;
        });

        log.audit('MR getInputData', 'SOs queued: ' + Object.keys(soIds).join(', '));
        return Object.keys(soIds).map(function (id) { return { soId: id }; });
    }

    // =========================================================================
    // MAP  (~lightweight — no record creates, no routing searches)
    // Reads the SO, builds job structure, emits one key/value per job
    // =========================================================================
    function map(context) {
        var soId = JSON.parse(context.value).soId;
        log.debug('MR Map - SO', soId);

        try {
            var mappingRefItems = getMappingItems();
            var soRec = record.load({ type: 'salesorder', id: soId });

            var rawShipDate = soRec.getValue({ fieldId: 'shipdate' });
            // Serialize as epoch ms so the date survives JSON.stringify through context.write.
            // Rebuilt into a Date object in reduce() before setValue (date fields require a Date, not a string).
            var shipDate    = rawShipDate ? rawShipDate.getTime() : null;
            var shipMethod = soRec.getValue({ fieldId: 'shipmethod' });
            var itemCount  = soRec.getLineCount({ sublistId: 'item' });

            var specialJobItems = [];
            var groupedItemsMap = {};
            var woidMap         = {};

            // Read all SO lines and build groupedItemsMap
            for (var i = 0; i < itemCount; i++) {
                var itemId        = soRec.getSublistValue({ sublistId: 'item', fieldId: 'item',                             line: i });
                var itemName      = soRec.getSublistText({  sublistId: 'item', fieldId: 'item',                             line: i });
                var clusterNum    = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_clusternum',        line: i });
                var woid          = soRec.getSublistValue({ sublistId: 'item', fieldId: 'woid',                            line: i });
                var quantity      = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',                        line: i });
                var lineuniquekey = soRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey',                   line: i });
                var lineid        = soRec.getSublistValue({ sublistId: 'item', fieldId: 'line',                            line: i });
                var pmsColors     = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_orders_pms_colors', line: i });

                if (!itemId || !clusterNum) continue;

                if (!groupedItemsMap[clusterNum]) groupedItemsMap[clusterNum] = [];

                var createdPlan = (mappingRefItems.indexOf(itemId) !== -1);
                var masterItem  = !!woid;

                groupedItemsMap[clusterNum].push({
                    itemId, itemName, quantity, clusterNum,
                    woid, lineuniquekey, lineid, createdPlan, masterItem, pmsColors
                });

                // Check if this item is a special job item (requires routing)
                var itemLookup = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['custitem_bpc_special_job_item'] });
                var isSpecial  = itemLookup.custitem_bpc_special_job_item;
                if ((isSpecial === true || isSpecial === 'T') && woid) {
                    specialJobItems.push(itemId);
                    woidMap[itemId] = woid;
                }
            }

            // Emit one entry per job — reduce will do the heavy lifting per job
            for (var cluster in groupedItemsMap) {
                var itemsInObject = distributeEmptyWoidItems(groupedItemsMap[cluster]);

                for (var spItem in itemsInObject) {
                    var itemsInGroup = itemsInObject[spItem];
                    var hasSpecialJobItem = itemsInGroup.some(function (g) { return specialJobItems.includes(g.itemId); });
                    if (!hasSpecialJobItem) continue;

                    // Build PMS colors for this cluster
                    var allPmsColorsArray = [];
                    groupedItemsMap[cluster].forEach(function (item) {
                        if (item.pmsColors) {
                            String(item.pmsColors).split(',').forEach(function (c) {
                                var t = c.trim();
                                if (t) allPmsColorsArray.push(t);
                            });
                        }
                    });

                    // Emit — key is unique per job, value carries everything reduce needs
                    var emitKey = soId + '___' + itemsInGroup[0].lineuniquekey;
                    context.write({
                        key: emitKey,
                        value: JSON.stringify({
                            soId:           soId,
                            shipDate:       shipDate,
                            shipMethod:     shipMethod,
                            cluster:        cluster,
                            itemsInGroup:   itemsInGroup,
                            specialJobItems: specialJobItems,
                            woidMap:        woidMap,
                            pmsColors:      allPmsColorsArray.join(',')
                        })
                    });
                }
            }

        } catch (e) {
            log.error('MR Map Error - SO ' + soId, e);
        }
    }

    // =========================================================================
    // REDUCE  (~heavy — one job per call, full 10,000 unit budget per job)
    // Creates/updates job record + planning details + fixes impressions
    // =========================================================================
    function reduce(context) {
        var payload      = JSON.parse(context.values[0]);
        var soId         = payload.soId;
        var itemsInGroup = payload.itemsInGroup;
        var specialJobItems = payload.specialJobItems;
        var woidMap      = payload.woidMap;
        var shipDate     = payload.shipDate;
        var shipMethod   = payload.shipMethod;

        log.debug('MR Reduce - Job', 'SO: ' + soId + ' | lineuniquekey: ' + itemsInGroup[0].lineuniquekey);

        try {
            var sky_jobRec   = getChildRecord(soId);
            var job_ChildRec = getJobChildRecord(soId);
            var mainHeadItem = itemsInGroup[0].itemId;

            // ── Load or create Job record ─────────────────────────────────────
            var jobRec;
            var jobRecId;

            if (sky_jobRec[itemsInGroup[0].lineuniquekey]) {
                jobRecId = sky_jobRec[itemsInGroup[0].lineuniquekey];
                jobRec   = record.load({ type: 'customrecord_sky_job', id: jobRecId, isDynamic: true });
            } else {
                jobRec = record.create({ type: 'customrecord_sky_job', isDynamic: true });
                jobRec.setValue('externalid', itemsInGroup[0].lineuniquekey);
            }

            jobRec.setValue({ fieldId: 'custrecord_sky_workorder',   value: itemsInGroup[0].woid });
            jobRec.setValue({ fieldId: 'custrecord_sky_item_group',  value: itemsInGroup[0].clusterNum });
            jobRec.setValue({ fieldId: 'custrecord_sky_lineid',      value: itemsInGroup[0].lineid });
            jobRec.setValue({ fieldId: 'custrecord_sky_sales_order', value: soId });
            // Rebuild Date object from epoch ms (NetSuite date fields reject string values).
            var shipDateVal = shipDate ? new Date(shipDate) : null;
            jobRec.setValue({ fieldId: 'custrecord_sky_ship_date',   value: shipDateVal });
            jobRec.setValue({ fieldId: 'custrecord_sky_ship_method', value: shipMethod });
            jobRec.setValue({ fieldId: 'custrecord_sky_parent_item', value: itemsInGroup[0].itemId });

            parseAndPopulateColors(payload.pmsColors, jobRec);

            var jobId = jobRec.save();
            jobRecId  = jobId;
            log.debug('MR Reduce - Job saved', jobId);

            var clusterWOID  = null;
            var masterQty    = 0;
            var headerMachine = null;

            // ── Create/update planning details for each item in the group ─────
            for (var j = 0; j < itemsInGroup.length; j++) {
                (function (groupItem) {
                    if (specialJobItems.includes(groupItem.itemId) && woidMap[groupItem.itemId]) {
                        clusterWOID = woidMap[groupItem.itemId];
                    }
                    if (groupItem.masterItem) masterQty = groupItem.quantity;

                    var division = groupItem.quantity / masterQty;

                    var routingSearch = search.create({
                        type: 'customrecord_bpc_mfg_routing_template',
                        filters: [
                            ['custrecord_bpc_mfg_routing_item', 'anyof', groupItem.itemId],
                            'AND',
                            ['formulanumeric: NVL({custrecord_bpc_mfg_routing_addcolor},0)', 'lessthan', (groupItem.masterItem ? 1 : division + 1)]
                        ],
                        columns: [
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_opnumber', sort: search.Sort.ASC }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_addcolor' }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_op_name' }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_item' }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_machine' }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_print_method' }),
                            search.createColumn({ name: 'custrecord_bpc_mfg_routing_setup' }),
                            search.createColumn({ name: 'custrecord_mfg_routing_process_time' })
                        ]
                    });

                    routingSearch.run().each(function (result) {
                        var opNum       = result.getValue({ name: 'custrecord_bpc_mfg_routing_opnumber' });
                        var opName      = result.getValue({ name: 'custrecord_bpc_mfg_routing_op_name' });
                        var routingItem = result.getValue({ name: 'custrecord_bpc_mfg_routing_item' });
                        var machine     = result.getValue({ name: 'custrecord_bpc_mfg_routing_machine' });
                        var printMethod = result.getValue({ name: 'custrecord_bpc_mfg_print_method' });
                        var isSetup     = result.getValue({ name: 'custrecord_bpc_mfg_routing_setup' });
                        var processTime = result.getValue({ name: 'custrecord_mfg_routing_process_time' });
                        var matchedWOID = clusterWOID;
                        var runRate     = null;
                        var woStatus    = null;

                        // Run rate lookup
                        if (routingItem && machine && mainHeadItem) {
                            var rrResults = search.create({
                                type: 'customrecord_bpc_sky_machine_run_rate_ta',
                                filters: [
                                    ['custrecord_bpc_sky_item',         'anyof', routingItem],
                                    'AND',
                                    ['custrecord_bpc_sky_machine',       'anyof', machine],
                                    'AND',
                                    ['custrecord_sky_item_assembly',     'anyof', mainHeadItem]
                                ],
                                columns: [
                                    'custrecord_bpc_sky_setup_time',
                                    search.createColumn({ name: 'formulatext',  formula: "case when {custrecord_bpc_sky_default_add} = 'Default'    then {custrecord_bpc_sky_run_rate} end", label: 'Formula (Text)' }),
                                    search.createColumn({ name: 'formulatext1', formula: "case when {custrecord_bpc_sky_default_add} = 'Additional' then {custrecord_bpc_sky_run_rate} end", label: 'Formula (Text)' })
                                ]
                            }).run().getRange({ start: 0, end: 1 });

                            var setupTime = '';
                            if (rrResults && rrResults.length > 0) {
                                var isDefaultRate = rrResults[0].getValue('formulatext');
                                var isAddRate     = rrResults[0].getValue('formulatext1');
                                var setupTimeV    = rrResults[0].getValue('custrecord_bpc_sky_setup_time');
                                if (isSetup) {
                                    setupTime = setupTimeV;
                                } else {
                                    if (groupItem.masterItem) runRate = isDefaultRate;
                                    else if (isAddRate)       runRate = isAddRate;
                                    else                      runRate = isDefaultRate;
                                }
                            }
                        }

                        // WO status lookup
                        if (matchedWOID) {
                            var woLookup = search.lookupFields({ type: record.Type.WORK_ORDER, id: matchedWOID, columns: ['status'] });
                            woStatus = (woLookup.status && woLookup.status[0]) ? woLookup.status[0].text : null;
                        }

                        // Load or create planning detail
                        var childKey = jobId + '---' + opNum + '---' + opName + '---' + routingItem + '---' + machine;
                        var planRec;
                        if (job_ChildRec[childKey]) {
                            planRec = record.load({ type: 'customrecord_bpc_job_planning_details', id: job_ChildRec[childKey], isDynamic: true });
                        } else {
                            planRec = record.create({ type: 'customrecord_bpc_job_planning_details', isDynamic: true });
                        }

                        planRec.setValue({ fieldId: 'custrecord_bpc_planning_job',           value: jobId });
                        planRec.setValue({ fieldId: 'custrecord_bpc_planning_precendence',    value: opNum });
                        planRec.setValue({ fieldId: 'custrecord_bpc_planning_op_name',        value: opName });
                        planRec.setValue({ fieldId: 'custrecord_bpc_wo_item',                value: routingItem });
                        planRec.setValue({ fieldId: 'custrecord_bpc_plandetail_print_method', value: printMethod });
                        planRec.setValue({ fieldId: 'custrecord_bpc_planning_machine',        value: machine });

                        if (!headerMachine && machine) headerMachine = machine;
                        if (matchedWOID) planRec.setValue({ fieldId: 'custrecord_bpc_planning_wo', value: matchedWOID });

                        if (!isSetup) {
                            planRec.setValue({ fieldId: 'custrecord_bpc_planning_qty', value: Math.round(groupItem.quantity / division) });
                        } else {
                            planRec.setValue({ fieldId: 'custrecord_bpc_planning_qty',  value: 1 });
                            planRec.setValue({ fieldId: 'custrecord_setup_operation',   value: true });
                        }

                        if (woStatus)    planRec.setValue({ fieldId: 'custrecord_bpc_sky_wo_status',           value: woStatus });
                        if (processTime) planRec.setValue({ fieldId: 'custrecord_bpc_sky_planned_time',        value: processTime });
                        if (setupTime)   planRec.setValue({ fieldId: 'custrecord_bpc_sky_planned_time',        value: setupTime });
                        if (runRate) {
                            planRec.setValue({ fieldId: 'custrecord_bpc_sky_planning_run_rate', value: runRate });
                            var plannedTime = parseFloat(groupItem.quantity / division) / parseFloat(runRate);
                            planRec.setValue({ fieldId: 'custrecord_bpc_sky_planned_time', value: plannedTime.toFixed(2) });
                        }

                        planRec.save();
                        return true;
                    });

                }(itemsInGroup[j]));
            }

            // ── Fix impressions for this job ──────────────────────────────────
            fixImpressions(jobRecId);

            // Emit soId so summarize knows which SOs to uncheck
            context.write({ key: soId, value: 'done' });

        } catch (e) {
            log.error('MR Reduce Error - SO ' + soId, e);
        }
    }

    // =========================================================================
    // SUMMARIZE
    // Uncheck error flags on all successfully processed SOs and their jobs
    // =========================================================================
    function summarize(summary) {
        log.audit('MR Summarize', 'Duration: ' + summary.seconds + 's | Usage: ' + summary.usage + ' units');

        // Collect unique SO IDs emitted by reduce
        var processedSOs = {};
        summary.output.iterator().each(function (key, value) {
            processedSOs[key] = true;
            return true;
        });

        // Uncheck SO flag
        Object.keys(processedSOs).forEach(function (soId) {
            try {
                record.submitFields({
                    type: 'salesorder',
                    id: soId,
                    values: { custbody_sky_job_error: false },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });

                // Uncheck job flags for this SO
                search.create({
                    type: 'customrecord_sky_job',
                    filters: [
                        ['custrecord_sky_sales_order', 'anyof', soId],
                        'AND',
                        ['custrecord_sky_job_error', 'is', 'T']
                    ],
                    columns: [search.createColumn({ name: 'internalid' })]
                }).run().each(function (r) {
                    record.submitFields({
                        type: 'customrecord_sky_job',
                        id: r.id,
                        values: { custrecord_sky_job_error: false },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                    return true;
                });

                log.audit('MR Summarize - Flags cleared', 'SO ' + soId);
            } catch (e) {
                log.error('MR Summarize - Error clearing flags for SO ' + soId, e);
            }
        });

        // Log any map/reduce errors
        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('MR Map Error', 'Key: ' + key + ' | ' + error);
            return true;
        });
        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error('MR Reduce Error', 'Key: ' + key + ' | ' + error);
            return true;
        });
    }

    // =========================================================================
    // HELPER: fixImpressions
    // =========================================================================
    function fixImpressions(jobRecId) {
        if (!jobRecId) return;

        var s = search.create({
            type: 'customrecord_sky_job',
            filters: [
                ['custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method', 'noneof', '@NONE@'],
                'AND',
                [
                    ['custrecord_bpc_planning_job.custrecord_bpc_planning_op_name', 'contains', 'Run'],
                    'OR',
                    ['custrecord_bpc_planning_job.custrecord_bpc_planning_op_name', 'contains', 'Setup']
                ],
                'AND',
                ['internalid', 'anyof', jobRecId]
            ],
            columns: [
                search.createColumn({ name: 'formulatext',  summary: 'GROUP', formula: "CASE WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 'Run' WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Setup%' THEN 'Setup' END", label: 'Type' }),
                search.createColumn({ name: 'formulatext',  summary: 'GROUP', formula: "CASE WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} != 'Machine Cutting Run' AND TRIM({custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method}) IN ('Traditional', 'Traditional : Screen Print', 'Traditional : Pad Print', 'Hi-Speed', 'Digital') THEN 'Regular' WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} = 'Machine Cutting Run' AND TRIM({custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method}) = 'Digital' THEN 'CUT' WHEN TRIM({custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method}) = 'Traditional : Hot Stamp' THEN 'HO' WHEN TRIM({custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method}) = 'Traditional : Emboss' THEN 'EM' WHEN TRIM({custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method}) = 'Traditional : Deboss' THEN 'DE' END", label: 'Machine' }),
                search.createColumn({ name: 'formulanumeric', summary: 'SUM', formula: "CASE WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 1 ELSE 0 END", label: 'Formula (Numeric)' }),
                search.createColumn({ name: 'custrecord_bpc_planning_qty', join: 'CUSTRECORD_BPC_PLANNING_JOB', summary: 'SUM', label: 'Quantity' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions',       summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_de',    summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_em',    summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_ho',    summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions',    summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_de', summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_em', summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_ho', summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_cut',   summary: 'MAX' }),
                search.createColumn({ name: 'custrecord_sky_total_impression_cut', summary: 'MAX' })
            ]
        });

        var results  = s.run().getRange({ start: 0, end: 1000 }) || [];
        var updateObj = {};

        for (var i = 0; i < results.length; i++) {
            var r         = results[i];
            var groupText = r.getValue(s.columns[0]) || '';
            var groupType = r.getValue(s.columns[1]) || '';
            var opCount   = Number(r.getValue(s.columns[2])) || 0;
            var qtySum    = Number(r.getValue(s.columns[3])) || 0;
            var regOP     = Number(r.getValue(s.columns[4])) || 0;
            var deOP      = Number(r.getValue(s.columns[5])) || 0;
            var emOP      = Number(r.getValue(s.columns[6])) || 0;
            var hoOP      = Number(r.getValue(s.columns[7])) || 0;
            var regQTY    = Number(r.getValue(s.columns[8])) || 0;
            var deQTY     = Number(r.getValue(s.columns[9])) || 0;
            var emQTY     = Number(r.getValue(s.columns[10])) || 0;
            var hoQTY     = Number(r.getValue(s.columns[11])) || 0;
            var cutOP     = Number(r.getValue(s.columns[12])) || 0;
            var cutQTY    = Number(r.getValue(s.columns[13])) || 0;

            if (groupText === 'Run') {
                if      (groupType === 'Regular' && opCount !== regOP) updateObj.custrecord_sky_no_impressions     = opCount;
                else if (groupType === 'EM'      && opCount !== emOP)  updateObj.custrecord_sky_no_impressions_em  = opCount;
                else if (groupType === 'HO'      && opCount !== hoOP)  updateObj.custrecord_sky_no_impressions_ho  = opCount;
                else if (groupType === 'DE'      && opCount !== deOP)  updateObj.custrecord_sky_no_impressions_de  = opCount;
                else if (groupType === 'CUT'     && opCount !== cutOP) updateObj.custrecord_sky_no_impressions_cut = opCount;

                if      (groupType === 'Regular' && qtySum !== regQTY) updateObj.custrecord_sky_total_impressions     = qtySum;
                else if (groupType === 'EM'      && qtySum !== emQTY)  updateObj.custrecord_sky_total_impressions_em  = qtySum;
                else if (groupType === 'HO'      && qtySum !== hoQTY)  updateObj.custrecord_sky_total_impressions_ho  = qtySum;
                else if (groupType === 'DE'      && qtySum !== deQTY)  updateObj.custrecord_sky_total_impressions_de  = qtySum;
                else if (groupType === 'CUT'     && qtySum !== cutQTY) updateObj.custrecord_sky_total_impression_cut  = qtySum;
            }
        }

        if (Object.keys(updateObj).length) {
            record.submitFields({
                type: 'customrecord_sky_job',
                id: jobRecId,
                values: updateObj,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            log.audit('fixImpressions - Updated', 'Job ' + jobRecId + ': ' + JSON.stringify(updateObj));
        }
    }

    // =========================================================================
    // HELPER: getChildRecord — { lineuniquekey → jobId } for a given SO
    // =========================================================================
    function getChildRecord(soId) {
        var map = {};
        search.create({
            type: 'customrecord_sky_job',
            filters: [['custrecord_sky_sales_order', 'anyof', soId]],
            columns: [search.createColumn({ name: 'internalid' }), search.createColumn({ name: 'externalid' })]
        }).run().each(function (r) {
            map[r.getValue('externalid')] = r.getValue('internalid');
            return true;
        });
        return map;
    }

    // =========================================================================
    // HELPER: getJobChildRecord — { compositeKey → planningDetailId } for a given SO
    // =========================================================================
    function getJobChildRecord(soId) {
        var map = {};
        search.create({
            type: 'customrecord_bpc_job_planning_details',
            filters: [['custrecord_bpc_planning_job.custrecord_sky_sales_order', 'anyof', soId]],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'custrecord_bpc_planning_job' }),
                search.createColumn({ name: 'custrecord_bpc_planning_precendence' }),
                search.createColumn({ name: 'custrecord_bpc_planning_op_name' }),
                search.createColumn({ name: 'custrecord_bpc_wo_item' }),
                search.createColumn({ name: 'custrecord_bpc_planning_machine' })
            ]
        }).run().each(function (r) {
            var key = r.getValue('custrecord_bpc_planning_job')         + '---' +
                      r.getValue('custrecord_bpc_planning_precendence') + '---' +
                      r.getValue('custrecord_bpc_planning_op_name')     + '---' +
                      r.getValue('custrecord_bpc_wo_item')              + '---' +
                      r.getValue('custrecord_bpc_planning_machine');
            map[key] = r.getValue('internalid');
            return true;
        });
        return map;
    }

    // =========================================================================
    // HELPER: getMappingItems — item IDs that have active routing templates
    // =========================================================================
    function getMappingItems() {
        var arr = [];
        search.create({
            type: 'customrecord_bpc_mfg_routing_template',
            filters: [['isinactive', 'is', 'F']],
            columns: [search.createColumn({ name: 'custrecord_bpc_mfg_routing_item', summary: 'GROUP' })]
        }).run().each(function (r) {
            var id = r.getValue({ name: 'custrecord_bpc_mfg_routing_item', summary: 'GROUP' });
            if (id) arr.push(id);
            return true;
        });
        return arr;
    }

    // =========================================================================
    // HELPER: distributeEmptyWoidItems + mergeItems
    // =========================================================================
    function mergeItems(data) {
        var result = {};
        Object.keys(data).forEach(function (woid) {
            var merged = {};
            data[woid].forEach(function (item) {
                var key = item.itemId + '-' + item.woid;
                if (item.createdPlan === true) {
                    if (!merged[key]) merged[key] = Object.assign({}, item);
                    else merged[key].quantity += item.quantity;
                } else {
                    merged[key + '-' + Math.random()] = Object.assign({}, item);
                }
            });
            result[woid] = Object.values(merged);
        });
        return result;
    }

    function distributeEmptyWoidItems(inputArray) {
        var output = {}, woidLines = [], emptyWoidLines = [];

        inputArray.forEach(function (row) {
            if (row.woid) woidLines.push(row);
            else          emptyWoidLines.push(row);
        });

        woidLines.forEach(function (row) {
            if (!output[row.woid]) output[row.woid] = [];
            output[row.woid].push(row);
        });

        emptyWoidLines.forEach(function (item) {
            var baseQty   = Math.floor(item.quantity / woidLines.length);
            var remainder = item.quantity % woidLines.length;
            woidLines.forEach(function (wLine, m) {
                var qty = baseQty + (m < remainder ? 1 : 0);
                if (qty > 0) {
                    output[wLine.woid].push(Object.assign({}, item, { quantity: qty, woid: wLine.woid }));
                }
            });
        });

        return mergeItems(output);
    }

    // =========================================================================
    // HELPER: parseAndPopulateColors
    // =========================================================================
    var pmsColorCache = {};

    function parseAndPopulateColors(colorString, jobRec) {
        if (!colorString) return;
        try {
            var colorIds = String(colorString).split(',').map(function (c) { return c.trim(); }).filter(Boolean);
            for (var i = 0; i < 10; i++) {
                var colorValue = colorIds[i] || null;
                if (colorValue) {
                    var norm = colorValue.toLowerCase();
                    if (pmsColorCache[norm]) {
                        colorValue = pmsColorCache[norm];
                    } else {
                        var res = search.create({
                            type: 'customrecord_extend_pms',
                            filters: [['name', 'is', colorValue]],
                            columns: [search.createColumn({ name: 'internalid' })]
                        }).run().getRange({ start: 0, end: 1 });
                        if (res && res.length > 0) {
                            colorValue = res[0].getValue('internalid');
                            pmsColorCache[norm] = colorValue;
                        } else {
                            pmsColorCache[norm] = colorValue;
                        }
                    }
                }
                try { jobRec.setValue({ fieldId: 'custrecord_sky_ink_color' + (i + 1), value: colorValue }); }
                catch (e) { log.error('parseAndPopulateColors', 'Field custrecord_sky_ink_color' + (i + 1) + ': ' + e.message); }
            }
        } catch (e) {
            log.error('parseAndPopulateColors', e);
        }
    }

    return { getInputData, map, reduce, summarize };
});