/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    const LIMITS = {
        USER_EVENT_JOB_LIMIT: 8,
        MAX_JOBS_PER_SO: 40
    };

    const QUEUE_FIELDS = {
        pending: 'custbody_bpc_sky_job_mr_pending',
        status: 'custbody_bpc_sky_job_mr_status',
        total: 'custbody_bpc_sky_job_total_count',
        processed: 'custbody_bpc_sky_job_created_count',
        message: 'custbody_bpc_sky_job_mr_message'
    };

    const STATUS = {
        PENDING: 'PENDING',
        PROCESSING: 'PROCESSING',
        COMPLETE: 'COMPLETE',
        ERROR: 'ERROR'
    };

    var pmsColorCache = {};

    function processSalesOrder(soId, options) {
        options = options || {};

        var maxJobs = Number(options.maxJobs || LIMITS.MAX_JOBS_PER_SO);
        if (!maxJobs || maxJobs < 1) maxJobs = LIMITS.MAX_JOBS_PER_SO;

        var prepared = prepareSalesOrder(soId);
        var totalJobs = prepared.jobGroups.length;

        log.audit('Sky job planning - prepared Sales Order', {
            soId: soId,
            source: options.source || '',
            totalJobs: totalJobs,
            maxJobs: maxJobs
        });

        if (totalJobs > LIMITS.MAX_JOBS_PER_SO) {
            return {
                success: false,
                soId: soId,
                totalJobs: totalJobs,
                processedJobs: 0,
                jobIds: [],
                maxExceeded: true,
                message: 'Sales Order requires ' + totalJobs + ' jobs; maximum supported is ' + LIMITS.MAX_JOBS_PER_SO + '.'
            };
        }

        if (!totalJobs) {
            return {
                success: true,
                soId: soId,
                totalJobs: 0,
                processedJobs: 0,
                jobIds: [],
                limitHit: false,
                message: 'No eligible Sky Jobs found for this Sales Order.'
            };
        }

        var jobGroupsToProcess = prepared.jobGroups.slice(0, Math.min(maxJobs, totalJobs));
        var skyJobMap = getChildRecord(soId);
        var jobChildMap = getJobChildRecord(soId);
        var jobIds = [];

        for (var i = 0; i < jobGroupsToProcess.length; i++) {
            var jobId = upsertJobGroup(prepared, jobGroupsToProcess[i], skyJobMap, jobChildMap);
            if (jobId) jobIds.push(jobId);
        }

        return {
            success: true,
            soId: soId,
            totalJobs: totalJobs,
            processedJobs: jobGroupsToProcess.length,
            jobIds: jobIds,
            limitHit: totalJobs > maxJobs,
            message: totalJobs > maxJobs
                ? 'Processed ' + jobGroupsToProcess.length + ' of ' + totalJobs + ' jobs; remaining jobs are queued for Map/Reduce.'
                : 'Processed all ' + totalJobs + ' jobs.'
        };
    }

    function prepareSalesOrder(soId) {
        const mappingRefItems = getMappingItems();
        const soRec = record.load({ type: record.Type.SALES_ORDER, id: soId });
        const shipDate = soRec.getValue({ fieldId: 'shipdate' });
        const shipMethod = soRec.getValue({ fieldId: 'shipmethod' });
        const itemCount = soRec.getLineCount({ sublistId: 'item' });

        let groupedItemsMap = {};
        let specialJobItems = [];
        let specialJobItemMap = {};
        let woidMap = {};
        let itemQuantityMap = {};

        log.debug('Sales Order item count', {
            soId: soId,
            itemCount: itemCount
        });

        for (let i = 0; i < itemCount; i++) {
            const itemId = soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            const itemName = soRec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i });
            const clusterNum = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_clusternum', line: i });
            const woid = soRec.getSublistValue({ sublistId: 'item', fieldId: 'woid', line: i });
            const quantity = Number(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
            const lineuniquekey = soRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
            const lineid = soRec.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i });
            const pmsColors = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_orders_pms_colors', line: i });

            if (!itemId || !clusterNum) continue;

            if (!groupedItemsMap[clusterNum]) groupedItemsMap[clusterNum] = [];

            const itemKey = String(itemId);
            const createdPlan = mappingRefItems.indexOf(itemKey) !== -1;
            const masterItem = !!woid;

            groupedItemsMap[clusterNum].push({
                itemId: itemId,
                itemName: itemName,
                quantity: quantity,
                clusterNum: clusterNum,
                woid: woid,
                lineuniquekey: lineuniquekey,
                lineid: lineid,
                createdPlan: createdPlan,
                masterItem: masterItem,
                pmsColors: pmsColors
            });

            if (!itemQuantityMap[itemKey]) {
                itemQuantityMap[itemKey] = { qty: 0, special: false };
            }
            itemQuantityMap[itemKey].qty = quantity;

            const itemLookup = search.lookupFields({
                type: search.Type.ITEM,
                id: itemId,
                columns: ['custitem_bpc_special_job_item']
            });

            const isSpecial = itemLookup.custitem_bpc_special_job_item;
            if ((isSpecial === true || isSpecial === 'T') && woid) {
                itemQuantityMap[itemKey].special = true;
                specialJobItemMap[itemKey] = true;
                if (specialJobItems.indexOf(itemKey) === -1) specialJobItems.push(itemKey);
                woidMap[itemKey] = woid;
            }
        }

        log.debug('Special Job Items with WOID', specialJobItems);
        log.debug('Grouped Items by Cluster', groupedItemsMap);
        log.debug('Item Quantity Map from SO', itemQuantityMap);

        return {
            soId: soId,
            shipDate: shipDate,
            shipMethod: shipMethod,
            groupedItemsMap: groupedItemsMap,
            specialJobItems: specialJobItems,
            specialJobItemMap: specialJobItemMap,
            woidMap: woidMap,
            jobGroups: buildJobGroups(groupedItemsMap, specialJobItemMap)
        };
    }

    function buildJobGroups(groupedItemsMap, specialJobItemMap) {
        var jobGroups = [];

        for (const cluster in groupedItemsMap) {
            const itemsInObject = distributeEmptyWoidItems(groupedItemsMap[cluster]);
            log.debug('Distributed items for cluster ' + cluster, itemsInObject);

            for (const spItem in itemsInObject) {
                const itemsInGroup = itemsInObject[spItem];
                const hasSpecialJobItem = itemsInGroup.some(function (groupItem) {
                    return !!specialJobItemMap[String(groupItem.itemId)];
                });

                if (!hasSpecialJobItem) continue;

                let allPmsColorsArray = [];
                groupedItemsMap[cluster].forEach(function (item) {
                    if (item.pmsColors) {
                        String(item.pmsColors).split(',').forEach(function (color) {
                            let trimmed = color.trim();
                            if (trimmed) allPmsColorsArray.push(trimmed);
                        });
                    }
                });

                jobGroups.push({
                    cluster: cluster,
                    woidKey: spItem,
                    externalKey: itemsInGroup[0] && itemsInGroup[0].lineuniquekey,
                    itemsInGroup: itemsInGroup,
                    pmsColors: allPmsColorsArray.join(',')
                });
            }
        }

        return jobGroups;
    }

    function upsertJobGroup(prepared, jobGroup, skyJobMap, jobChildMap) {
        const soId = prepared.soId;
        const itemsInGroup = jobGroup.itemsInGroup;
        if (!itemsInGroup || !itemsInGroup.length) return null;

        var jobRec;
        var jobRecId = null;
        var externalKey = jobGroup.externalKey || itemsInGroup[0].lineuniquekey;

        if (skyJobMap[externalKey]) {
            jobRec = record.load({
                type: 'customrecord_sky_job',
                id: skyJobMap[externalKey],
                isDynamic: true
            });
            jobRecId = skyJobMap[externalKey];
        } else {
            jobRec = record.create({
                type: 'customrecord_sky_job',
                isDynamic: true
            });
            jobRec.setValue({ fieldId: 'externalid', value: externalKey });
        }

        jobRec.setValue({ fieldId: 'custrecord_sky_workorder', value: itemsInGroup[0].woid });
        jobRec.setValue({ fieldId: 'custrecord_sky_item_group', value: itemsInGroup[0].clusterNum });
        jobRec.setValue({ fieldId: 'custrecord_sky_lineid', value: itemsInGroup[0].lineid });
        jobRec.setValue({ fieldId: 'custrecord_sky_sales_order', value: soId });
        jobRec.setValue({ fieldId: 'custrecord_sky_ship_date', value: prepared.shipDate });
        jobRec.setValue({ fieldId: 'custrecord_sky_ship_method', value: prepared.shipMethod });
        jobRec.setValue({ fieldId: 'custrecord_sky_parent_item', value: itemsInGroup[0].itemId });

        parseAndPopulateColors(jobGroup.pmsColors, jobRec);

        const jobId = jobRec.save();
        jobRecId = jobId;
        skyJobMap[externalKey] = jobId;

        log.debug('Sky Job upserted', {
            soId: soId,
            cluster: jobGroup.cluster,
            jobId: jobId,
            externalKey: externalKey
        });

        createOrUpdatePlanningDetails(prepared, itemsInGroup, jobId, jobChildMap);
        updateJobImpressionTotals(jobRecId);

        return jobId;
    }

    function createOrUpdatePlanningDetails(prepared, itemsInGroup, jobId, jobChildMap) {
        let headerMachine = null;
        let clusterWOID = null;
        let masterQty = 0;
        let mainHeadItem = itemsInGroup[0].itemId;

        for (let j = 0; j < itemsInGroup.length; j++) {
            const itemId = itemsInGroup[j].itemId;
            const itemKey = String(itemId);

            if (prepared.specialJobItemMap[itemKey] && prepared.woidMap[itemKey]) {
                clusterWOID = prepared.woidMap[itemKey];
            }

            if (itemsInGroup[j].masterItem) masterQty = Number(itemsInGroup[j].quantity) || 0;

            const lineQty = Number(itemsInGroup[j].quantity) || 0;
            const division = masterQty ? (lineQty / masterQty) : 1;
            const routingAddColorLimit = itemsInGroup[j].masterItem ? 1 : division + 1;

            log.debug('Planning line quantity split', {
                jobId: jobId,
                itemId: itemId,
                masterQty: masterQty,
                lineQty: lineQty,
                division: division,
                routingAddColorLimit: routingAddColorLimit
            });

            const routingSearch = search.create({
                type: 'customrecord_bpc_mfg_routing_template',
                filters: [
                    ['custrecord_bpc_mfg_routing_item', 'anyof', itemId],
                    'AND',
                    ['formulanumeric: NVL({custrecord_bpc_mfg_routing_addcolor},0)', 'lessthan', routingAddColorLimit]
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
                const opNum = result.getValue({ name: 'custrecord_bpc_mfg_routing_opnumber' });
                const opName = result.getValue({ name: 'custrecord_bpc_mfg_routing_op_name' });
                const routingItem = result.getValue({ name: 'custrecord_bpc_mfg_routing_item' });
                const machine = result.getValue({ name: 'custrecord_bpc_mfg_routing_machine' });
                const printMethod = result.getValue({ name: 'custrecord_bpc_mfg_print_method' });
                const isSetup = result.getValue({ name: 'custrecord_bpc_mfg_routing_setup' });
                const processTime = result.getValue({ name: 'custrecord_mfg_routing_process_time' });

                const matchedWOID = clusterWOID;
                let runRate = null;
                let woStatus = null;
                let setupTime = '';

                if (routingItem && machine && mainHeadItem) {
                    const runRateSearch = search.create({
                        type: 'customrecord_bpc_sky_machine_run_rate_ta',
                        filters: [
                            ['custrecord_bpc_sky_item', 'anyof', routingItem],
                            'AND',
                            ['custrecord_bpc_sky_machine', 'anyof', machine],
                            'AND',
                            ['custrecord_sky_item_assembly', 'anyof', mainHeadItem]
                        ],
                        columns: [
                            'custrecord_bpc_sky_setup_time',
                            search.createColumn({
                                name: 'formulatext',
                                formula: "case when {custrecord_bpc_sky_default_add} = 'Default' then {custrecord_bpc_sky_run_rate} end",
                                label: 'Formula (Text)'
                            }),
                            search.createColumn({
                                name: 'formulatext1',
                                formula: "case when {custrecord_bpc_sky_default_add} = 'Additional' then {custrecord_bpc_sky_run_rate} end",
                                label: 'Formula (Text)'
                            })
                        ]
                    });

                    var runRateResults = runRateSearch.run().getRange({ start: 0, end: 1 });
                    var masterItemRate = itemsInGroup[j].masterItem;

                    if (runRateResults && runRateResults.length > 0) {
                        var isDefaultRate = runRateResults[0].getValue('formulatext');
                        var isAddRate = runRateResults[0].getValue('formulatext1');
                        var setupTimeV = runRateResults[0].getValue('custrecord_bpc_sky_setup_time');

                        if (isSetup) {
                            setupTime = setupTimeV;
                        } else if (masterItemRate) {
                            runRate = isDefaultRate;
                        } else if (isAddRate) {
                            runRate = isAddRate;
                        } else {
                            runRate = isDefaultRate;
                        }
                    }
                }

                if (matchedWOID) {
                    const woLookup = search.lookupFields({
                        type: record.Type.WORK_ORDER,
                        id: matchedWOID,
                        columns: ['status']
                    });

                    woStatus = woLookup.status && woLookup.status[0] ? woLookup.status[0].text : null;
                }

                var childKey = buildPlanningDetailKey(jobId, opNum, opName, routingItem, machine);
                var planRec;

                if (jobChildMap[childKey]) {
                    planRec = record.load({
                        type: 'customrecord_bpc_job_planning_details',
                        id: jobChildMap[childKey],
                        isDynamic: true
                    });
                } else {
                    planRec = record.create({
                        type: 'customrecord_bpc_job_planning_details',
                        isDynamic: true
                    });
                }

                planRec.setValue({ fieldId: 'custrecord_bpc_planning_job', value: jobId });
                planRec.setValue({ fieldId: 'custrecord_bpc_planning_precendence', value: opNum });
                planRec.setValue({ fieldId: 'custrecord_bpc_planning_op_name', value: opName });
                planRec.setValue({ fieldId: 'custrecord_bpc_wo_item', value: routingItem });
                planRec.setValue({ fieldId: 'custrecord_bpc_plandetail_print_method', value: printMethod });
                planRec.setValue({ fieldId: 'custrecord_bpc_planning_machine', value: machine });

                if (!headerMachine && machine) headerMachine = machine;

                if (matchedWOID) {
                    planRec.setValue({ fieldId: 'custrecord_bpc_planning_wo', value: matchedWOID });
                }

                if (!isSetup) {
                    planRec.setValue({
                        fieldId: 'custrecord_bpc_planning_qty',
                        value: Math.round(masterQty ? lineQty / division : lineQty)
                    });
                } else {
                    planRec.setValue({ fieldId: 'custrecord_bpc_planning_qty', value: 1 });
                    planRec.setValue({ fieldId: 'custrecord_setup_operation', value: true });
                }

                if (woStatus) {
                    planRec.setValue({ fieldId: 'custrecord_bpc_sky_wo_status', value: woStatus });
                }

                if (runRate) {
                    planRec.setValue({ fieldId: 'custrecord_bpc_sky_planning_run_rate', value: runRate });
                }

                if (processTime) {
                    planRec.setValue({ fieldId: 'custrecord_bpc_sky_planned_time', value: processTime });
                }

                if (setupTime) {
                    planRec.setValue({ fieldId: 'custrecord_bpc_sky_planned_time', value: setupTime });
                }

                if (runRate) {
                    const plannedTime = parseFloat(masterQty ? lineQty / division : lineQty) / parseFloat(runRate);
                    planRec.setValue({
                        fieldId: 'custrecord_bpc_sky_planned_time',
                        value: plannedTime.toFixed(2)
                    });
                }

                const planId = planRec.save();
                jobChildMap[childKey] = planId;

                log.debug('Planning record upserted', {
                    planId: planId,
                    jobId: jobId,
                    routingItem: routingItem,
                    matchedWOID: matchedWOID,
                    runRate: runRate,
                    woStatus: woStatus
                });

                return true;
            });
        }
    }

    function updateJobImpressionTotals(jobRecId) {
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
                search.createColumn({
                    name: 'formulatext',
                    summary: 'GROUP',
                    formula: "CASE  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 'Run'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Setup%' THEN 'Setup'  END",
                    label: 'Type'
                }),
                search.createColumn({
                    name: 'formulatext',
                    summary: 'GROUP',
                    formula: "CASE   WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} != 'Machine Cutting Run' AND {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} IN   ('Traditional', 'Traditional : Screen Print', 'Traditional : Pad Print', 'Hi-Speed', 'Digital ')   THEN 'Regular' WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} = 'Machine Cutting Run' AND {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Digital '   THEN 'CUT'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Hot Stamp'   THEN 'HO'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Emboss'   THEN 'EM'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Deboss'   THEN 'DE'END",
                    label: 'Machine'
                }),
                search.createColumn({
                    name: 'formulanumeric',
                    summary: 'SUM',
                    formula: "CASE  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 1 ELSE 0 END",
                    label: 'Formula (Numeric)'
                }),
                search.createColumn({
                    name: 'custrecord_bpc_planning_qty',
                    join: 'CUSTRECORD_BPC_PLANNING_JOB',
                    summary: 'SUM',
                    label: 'Quantity'
                }),
                search.createColumn({ name: 'custrecord_sky_no_impressions', summary: 'MAX', label: 'No. of Impressions' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_de', summary: 'MAX', label: 'No. of Impressions DE' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_em', summary: 'MAX', label: 'No. of Impressions EM' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_ho', summary: 'MAX', label: 'No. of Impressions HO' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions', summary: 'MAX', label: 'Total of Impressions' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_de', summary: 'MAX', label: 'Total of Impressions DE' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_em', summary: 'MAX', label: 'Total of Impressions EM' }),
                search.createColumn({ name: 'custrecord_sky_total_impressions_ho', summary: 'MAX', label: 'Total of Impressions HO' }),
                search.createColumn({ name: 'custrecord_sky_no_impressions_cut', summary: 'MAX', label: 'No. of Impressions Cut' }),
                search.createColumn({ name: 'custrecord_sky_total_impression_cut', summary: 'MAX', label: 'Total of Impressions Cut' })
            ]
        });

        var updateObj = {};
        var results = s.run().getRange({ start: 0, end: 1000 }) || [];

        if (!results.length) {
            log.debug('Sky Job impression totals', {
                jobRecId: jobRecId,
                message: 'No search results. Nothing to update.'
            });
            return;
        }

        for (var i = 0; i < results.length; i++) {
            var r = results[i];

            var groupText = r.getValue(s.columns[0]) || '';
            var groupType = r.getValue(s.columns[1]) || '';
            var opCount = Number(r.getValue(s.columns[2])) || 0;
            var qtySum = Number(r.getValue(s.columns[3])) || 0;
            var regOP = Number(r.getValue(s.columns[4])) || 0;
            var deOP = Number(r.getValue(s.columns[5])) || 0;
            var emOP = Number(r.getValue(s.columns[6])) || 0;
            var hoOP = Number(r.getValue(s.columns[7])) || 0;
            var regQTY = Number(r.getValue(s.columns[8])) || 0;
            var deQTY = Number(r.getValue(s.columns[9])) || 0;
            var emQTY = Number(r.getValue(s.columns[10])) || 0;
            var hoQTY = Number(r.getValue(s.columns[11])) || 0;
            var cutOP = Number(r.getValue(s.columns[12])) || 0;
            var cutQTY = Number(r.getValue(s.columns[13])) || 0;

            if (groupText == 'Run') {
                if (groupType == 'Regular' && opCount != regOP) updateObj.custrecord_sky_no_impressions = opCount;
                else if (groupType == 'EM' && opCount != emOP) updateObj.custrecord_sky_no_impressions_em = opCount;
                else if (groupType == 'HO' && opCount != hoOP) updateObj.custrecord_sky_no_impressions_ho = opCount;
                else if (groupType == 'DE' && opCount != deOP) updateObj.custrecord_sky_no_impressions_de = opCount;
                else if (groupType == 'CUT' && opCount != cutOP) updateObj.custrecord_sky_no_impressions_cut = opCount;
            }

            if (groupText == 'Run') {
                if (groupType == 'Regular' && qtySum != regQTY) updateObj.custrecord_sky_total_impressions = qtySum;
                else if (groupType == 'EM' && qtySum != emQTY) updateObj.custrecord_sky_total_impressions_em = qtySum;
                else if (groupType == 'HO' && qtySum != hoQTY) updateObj.custrecord_sky_total_impressions_ho = qtySum;
                else if (groupType == 'DE' && qtySum != deQTY) updateObj.custrecord_sky_total_impressions_de = qtySum;
                else if (groupType == 'CUT' && qtySum != cutQTY) updateObj.custrecord_sky_total_impression_cut = qtySum;
            }
        }

        log.debug('Sky Job impression update values', JSON.stringify(updateObj));

        if (Object.keys(updateObj).length) {
            record.submitFields({
                type: 'customrecord_sky_job',
                id: jobRecId,
                values: updateObj,
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });
        } else {
            log.debug('No Sky Job impression update needed', jobRecId);
        }
    }

    function setQueueStatus(soId, values) {
        var submitValues = {};

        if (Object.prototype.hasOwnProperty.call(values, 'pending')) submitValues[QUEUE_FIELDS.pending] = values.pending;
        if (Object.prototype.hasOwnProperty.call(values, 'status')) submitValues[QUEUE_FIELDS.status] = values.status;
        if (Object.prototype.hasOwnProperty.call(values, 'total')) submitValues[QUEUE_FIELDS.total] = values.total;
        if (Object.prototype.hasOwnProperty.call(values, 'processed')) submitValues[QUEUE_FIELDS.processed] = values.processed;
        if (Object.prototype.hasOwnProperty.call(values, 'message')) submitValues[QUEUE_FIELDS.message] = values.message || '';

        if (!Object.keys(submitValues).length) return;

        record.submitFields({
            type: record.Type.SALES_ORDER,
            id: soId,
            values: submitValues,
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });
    }

    function getChildRecord(recid) {
        var returnObj = {};
        var customrecord_sky_jobSearchObj = search.create({
            type: 'customrecord_sky_job',
            filters: [
                ['custrecord_sky_sales_order', 'anyof', recid]
            ],
            columns: [
                search.createColumn({ name: 'internalid', label: 'Internal ID' }),
                search.createColumn({ name: 'externalid', label: 'externalid' }),
                search.createColumn({ name: 'custrecord_sky_ship_method', label: 'Ship Method' }),
                search.createColumn({ name: 'custrecord_sky_parent_item', label: 'Parent Item' })
            ]
        });

        log.debug('Sky Job result count', customrecord_sky_jobSearchObj.runPaged().count);

        customrecord_sky_jobSearchObj.run().each(function (result) {
            var externalid = result.getValue('externalid');
            if (externalid) returnObj[externalid] = result.getValue('internalid');
            return true;
        });

        return returnObj;
    }

    function getJobChildRecord(recid) {
        var returnObj = {};
        var customrecord_bpc_job_planning_detailsSearchObj = search.create({
            type: 'customrecord_bpc_job_planning_details',
            filters: [
                ['custrecord_bpc_planning_job.custrecord_sky_sales_order', 'anyof', recid]
            ],
            columns: [
                search.createColumn({ name: 'internalid', label: 'Internal ID' }),
                search.createColumn({ name: 'custrecord_bpc_planning_job', label: 'Job' }),
                search.createColumn({ name: 'custrecord_bpc_planning_precendence', label: 'Precedence' }),
                search.createColumn({ name: 'custrecord_bpc_planning_op_name', label: 'Operation Name' }),
                search.createColumn({ name: 'custrecord_bpc_wo_item', label: 'Item' }),
                search.createColumn({ name: 'custrecord_bpc_planning_machine', label: 'Machine' })
            ]
        });

        log.debug('Planning detail result count', customrecord_bpc_job_planning_detailsSearchObj.runPaged().count);

        customrecord_bpc_job_planning_detailsSearchObj.run().each(function (result) {
            var job = result.getValue('custrecord_bpc_planning_job');
            var precendence = result.getValue('custrecord_bpc_planning_precendence');
            var name = result.getValue('custrecord_bpc_planning_op_name');
            var item = result.getValue('custrecord_bpc_wo_item');
            var machine = result.getValue('custrecord_bpc_planning_machine');
            var id = result.getValue('internalid');
            var key = buildPlanningDetailKey(job, precendence, name, item, machine);

            returnObj[key] = id;
            return true;
        });

        return returnObj;
    }

    function buildPlanningDetailKey(job, precendence, name, item, machine) {
        return [
            normalizeKeyValue(job),
            normalizeKeyValue(precendence),
            normalizeKeyValue(name),
            normalizeKeyValue(item),
            normalizeKeyValue(machine)
        ].join('---');
    }

    function normalizeKeyValue(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function mergeItems(data) {
        const result = {};

        Object.keys(data).forEach(function (woid) {
            const items = data[woid];
            const merged = {};

            items.forEach(function (item, index) {
                const key = item.itemId + '-' + item.woid;

                if (item.createdPlan === true) {
                    if (!merged[key]) {
                        merged[key] = Object.assign({}, item);
                    } else {
                        merged[key].quantity += item.quantity;
                    }
                } else {
                    merged[key + '-' + index] = Object.assign({}, item);
                }
            });

            result[woid] = Object.keys(merged).map(function (key) {
                return merged[key];
            });
        });

        return result;
    }

    function distributeEmptyWoidItems(inputArray) {
        var output = {};
        var woidLines = [];
        var emptyWoidLines = [];

        for (var i = 0; i < inputArray.length; i++) {
            var row = inputArray[i];
            if (row.woid) {
                woidLines.push(row);
            } else {
                emptyWoidLines.push(row);
            }
        }

        for (var j = 0; j < woidLines.length; j++) {
            var woid = woidLines[j].woid;
            if (!output[woid]) output[woid] = [];
            output[woid].push(woidLines[j]);
        }

        if (!woidLines.length) return output;

        for (var k = 0; k < emptyWoidLines.length; k++) {
            var item = emptyWoidLines[k];
            var totalQty = Number(item.quantity) || 0;
            var groupCount = woidLines.length;

            var baseQty = Math.floor(totalQty / groupCount);
            var remainder = totalQty % groupCount;

            for (var m = 0; m < groupCount; m++) {
                var qtyToAssign = baseQty + (m < remainder ? 1 : 0);

                if (qtyToAssign > 0) {
                    var clone = {
                        itemId: item.itemId,
                        itemName: item.itemName,
                        createdPlan: item.createdPlan,
                        masterItem: item.masterItem,
                        quantity: qtyToAssign,
                        woid: woidLines[m].woid,
                        clusterNum: item.clusterNum,
                        lineuniquekey: item.lineuniquekey,
                        lineid: item.lineid,
                        pmsColors: item.pmsColors
                    };
                    output[woidLines[m].woid].push(clone);
                }
            }
        }

        return mergeItems(output);
    }

    function getMappingItems() {
        var returnArray = [];

        var customrecord_bpc_mfg_routing_templateSearchObj = search.create({
            type: 'customrecord_bpc_mfg_routing_template',
            filters: [
                ['isinactive', 'is', 'F']
            ],
            columns: [
                search.createColumn({
                    name: 'custrecord_bpc_mfg_routing_item',
                    summary: 'GROUP',
                    label: 'Item'
                })
            ]
        });

        log.debug('Routing template item result count', customrecord_bpc_mfg_routing_templateSearchObj.runPaged().count);

        customrecord_bpc_mfg_routing_templateSearchObj.run().each(function (result) {
            var itemId = result.getValue({
                name: 'custrecord_bpc_mfg_routing_item',
                summary: 'GROUP'
            });

            if (itemId) returnArray.push(String(itemId));

            return true;
        });

        return returnArray;
    }

    function parseAndPopulateColors(colorString, jobRec) {
        log.debug('colorString', colorString);

        if (!colorString) return;

        try {
            const colorIds = String(colorString).split(',').map(function (id) {
                return id.trim();
            }).filter(function (id) {
                return id;
            });

            log.debug('Parsing colors', {
                colorIds: colorIds,
                total: colorIds.length
            });

            for (let i = 0; i < 10; i++) {
                let colorValue = colorIds[i] || null;

                if (colorValue) {
                    let normalizedColor = colorValue.toLowerCase();
                    if (pmsColorCache[normalizedColor]) {
                        colorValue = pmsColorCache[normalizedColor];
                    } else {
                        var customrecord_extend_pmsSearchObj = search.create({
                            type: 'customrecord_extend_pms',
                            filters: [
                                ['name', 'is', colorValue]
                            ],
                            columns: [
                                search.createColumn({ name: 'internalid', label: 'Internal ID' })
                            ]
                        });

                        var searchResults = customrecord_extend_pmsSearchObj.run().getRange({ start: 0, end: 1 });
                        if (searchResults && searchResults.length > 0) {
                            let foundId = searchResults[0].getValue('internalid');
                            pmsColorCache[normalizedColor] = foundId;
                            colorValue = foundId;
                        } else {
                            pmsColorCache[normalizedColor] = colorValue;
                        }
                    }
                }

                const fieldId = 'custrecord_sky_ink_color' + (i + 1);
                try {
                    jobRec.setValue({ fieldId: fieldId, value: colorValue });
                } catch (e) {
                    log.error('Error setting color field ' + fieldId, e.message);
                }
            }
        } catch (e) {
            log.error('Error in parseAndPopulateColors', e);
        }
    }

    function getInputData() {
        return search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [QUEUE_FIELDS.pending, 'is', 'T'],
                'AND',
                [QUEUE_FIELDS.status, 'isnot', STATUS.ERROR]
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid' })
            ]
        });
    }

    function map(context) {
        var searchResult = JSON.parse(context.value);
        var soId = searchResult.id;

        if (!soId && searchResult.values && searchResult.values.internalid) {
            soId = searchResult.values.internalid.value || searchResult.values.internalid;
        }

        if (!soId) {
            log.error('Queued Sky Job Sales Order result missing internal ID', searchResult);
            return;
        }

        try {
            setQueueStatus(soId, {
                pending: true,
                status: STATUS.PROCESSING,
                message: 'Map/Reduce processing started.'
            });

            const result = processSalesOrder(soId, {
                maxJobs: LIMITS.MAX_JOBS_PER_SO,
                source: 'Map/Reduce'
            });

            if (result.maxExceeded) {
                setQueueStatus(soId, {
                    pending: true,
                    status: STATUS.ERROR,
                    total: result.totalJobs,
                    processed: 0,
                    message: result.message
                });
                log.error('Sky Job count exceeds supported maximum in Map/Reduce', result);
                return;
            }

            setQueueStatus(soId, {
                pending: false,
                status: STATUS.COMPLETE,
                total: result.totalJobs,
                processed: result.processedJobs,
                message: result.message
            });

            log.audit('Sky Job Map/Reduce processing complete', result);
        } catch (error) {
            log.error('Error processing queued Sky Job Sales Order', {
                soId: soId,
                error: error
            });

            try {
                setQueueStatus(soId, {
                    pending: true,
                    status: STATUS.ERROR,
                    message: error && error.message ? error.message : String(error)
                });
            } catch (queueError) {
                log.error('Unable to update Sky Job queue fields after Map/Reduce error', queueError);
            }

            throw error;
        }
    }

    function summarize(summary) {
        log.audit('Sky Job Map/Reduce summary', {
            seconds: summary.seconds,
            usage: summary.usage,
            yields: summary.yields,
            concurrency: summary.concurrency
        });

        if (summary.inputSummary.error) {
            log.error('Sky Job Map/Reduce input error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('Sky Job Map/Reduce map error ' + key, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
