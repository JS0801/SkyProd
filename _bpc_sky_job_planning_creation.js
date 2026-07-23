/**
* @NApiVersion 2.1
* @NScriptType UserEventScript
*/
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    const USER_EVENT_JOB_LIMIT = 8;
    const SKY_JOB_MR_FIELDS = {
        pending: 'custbody_bpc_sky_job_mr_pending',
        status: 'custbody_bpc_sky_job_mr_status',
        message: 'custbody_bpc_sky_job_mr_message'
    };

    function afterSubmit(context) {
        try {
            log.debug('type', context.type)
            if (context.type == context.UserEventType.DELETE) return;

            const newRecord = context.newRecord;
            const soId = newRecord.id;
            const isQueuedForMR = newRecord.getValue({ fieldId: SKY_JOB_MR_FIELDS.pending });
            if (isQueuedForMR === true || isQueuedForMR === 'T') return;

            const mappingRefItems = getMappingItems();
            log.debug('soId', soId)
            log.debug('mappingRefItems', mappingRefItems)


            const customrecord_sky_jobSearchObj = search.create({
                type: "customrecord_sky_job",
                filters:
                    [
                        ["custrecord_sky_sales_order", "anyof", soId]
                    ],
                columns:
                    [
                        search.createColumn({ name: "internalid", label: "Internal ID" })
                    ]
            });
            const searchResultCount = customrecord_sky_jobSearchObj.runPaged().count;
            log.debug("customrecord_sky_jobSearchObj result count", searchResultCount);
            if (searchResultCount > 0 && soId != 33891) return;

            const soRec = record.load({ type: 'salesorder', id: soId })

            const Setup_Charge = 10;
            const shipDate = soRec.getValue({ fieldId: 'shipdate' });
            const shipDateKey = soRec.getValue({ fieldId: 'shipdate' });
            const shipMethod = soRec.getValue({ fieldId: 'shipmethod' });
            const itemCount = soRec.getLineCount({ sublistId: 'item' });

            let specialJobItems = [];
            let groupedItemsMap = {};
            let woidMap = {};
            let itemQuantityMap = {};

            log.debug('Item Count', itemCount);

            for (let i = 0; i < itemCount; i++) {
                const itemId = soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const itemName = soRec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i });
                const clusterNum = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_clusternum', line: i });
                const woid = soRec.getSublistValue({ sublistId: 'item', fieldId: 'woid', line: i });
                const quantity = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
                const lineuniquekey = soRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
                const lineid = soRec.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i });
                const pmsColors = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_extend_orders_pms_colors', line: i });
                log.debug('lineuniquekey', {
                    lineuniquekey: lineuniquekey,
                    pmsColors: pmsColors
                })

                if (!itemId || !clusterNum) continue;

                if (!groupedItemsMap[clusterNum]) groupedItemsMap[clusterNum] = [];
                var createdPlan = false;
                if (mappingRefItems.indexOf(itemId) != -1) createdPlan = true;

                var masterItem = false;
                if (woid) masterItem = true;
                groupedItemsMap[clusterNum].push({ itemId, itemName, quantity, clusterNum, woid, lineuniquekey, lineid, createdPlan, masterItem, pmsColors });

                if (!itemQuantityMap[itemId]) {
                    itemQuantityMap[itemId] = { qty: 0, special: false };
                }

                itemQuantityMap[itemId].qty = quantity;


                const itemLookup = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['custitem_bpc_special_job_item']
                });

                const isSpecial = itemLookup.custitem_bpc_special_job_item;
                if ((isSpecial === true || isSpecial === 'T') && woid) {
                    itemQuantityMap[itemId].special = true;
                    specialJobItems.push(itemId);
                    woidMap[itemId] = woid;
                }
            }

            log.debug('Special Job Items with WOID', specialJobItems);
            log.debug('Grouped Items by Cluster', groupedItemsMap);
            log.debug('Item Quantity Map from SO', itemQuantityMap);

            const skyJobCreationCount = getSkyJobCreationCount(groupedItemsMap, specialJobItems);
            log.debug('skyJobCreationCount', skyJobCreationCount);

            if (skyJobCreationCount > USER_EVENT_JOB_LIMIT) {
                markSalesOrderForMapReduce(soId, skyJobCreationCount);
                return;
            }

            var sky_jobRec = getChildRecord(soId);
            var job_ChildRec = getJobChildRecord(soId);

            log.debug('sky_jobRec', sky_jobRec);
            log.debug('job_ChildRec', job_ChildRec);
            log.debug('groupedItemsMap', groupedItemsMap);

            for (const cluster in groupedItemsMap) {

                const itemsInObject = distributeEmptyWoidItems(groupedItemsMap[cluster]);
                log.debug('Item itemsInObject', itemsInObject);

                for (const spItem in itemsInObject) {
                    const keyCount = Object.keys(itemsInObject).length;
                    const itemsInGroup = itemsInObject[spItem];
                    // const hasSpecialJobItem = itemsInGroup.some(itemId => specialJobItems.includes(itemId));
                    const hasSpecialJobItem = itemsInGroup.some(groupItem =>
                        specialJobItems.includes(groupItem.itemId)
                    );
                    if (!hasSpecialJobItem) continue;
                    var addColorQty = 0;
                    var masterQty = 0;
                    let clusterWOID = null;
                    let jobRecId = null;
                    let mainHeadItem = itemsInGroup[0].itemId;

                    if (sky_jobRec[itemsInGroup[0].lineuniquekey]) {
                        var jobRec = record.load({
                            type: 'customrecord_sky_job',
                            id: sky_jobRec[itemsInGroup[0].lineuniquekey],
                            isDynamic: true
                        });
                        jobRecId = sky_jobRec[itemsInGroup[0].lineuniquekey];
                    }
                    else {
                        var jobRec = record.create({
                            type: 'customrecord_sky_job',
                            isDynamic: true
                        });
                        jobRec.setValue('externalid', itemsInGroup[0].lineuniquekey)
                    }
                    jobRec.setValue({ fieldId: 'custrecord_sky_workorder', value: itemsInGroup[0].woid });
                    jobRec.setValue({ fieldId: 'custrecord_sky_item_group', value: itemsInGroup[0].clusterNum });
                    jobRec.setValue({ fieldId: 'custrecord_sky_lineid', value: itemsInGroup[0].lineid });
                    jobRec.setValue({ fieldId: 'custrecord_sky_sales_order', value: soId });
                    jobRec.setValue({ fieldId: 'custrecord_sky_ship_date', value: shipDate });
                    jobRec.setValue({ fieldId: 'custrecord_sky_ship_method', value: shipMethod });
                    jobRec.setValue({ fieldId: 'custrecord_sky_parent_item', value: itemsInGroup[0].itemId });
                    
                    let allPmsColorsArray = [];
                    groupedItemsMap[cluster].forEach(item => {
                        if (item.pmsColors) {
                            String(item.pmsColors).split(',').forEach(c => {
                                let trimmed = c.trim();
                                if (trimmed) {
                                    allPmsColorsArray.push(trimmed);
                                }
                            });
                        }
                    });
                    parseAndPopulateColors(allPmsColorsArray.join(','), jobRec);

                    const jobId = jobRec.save();
                    jobRecId = jobId;

                    log.debug(`Job created for cluster ${cluster}`, jobId);
                    let headerMachine = null;

                    for (let j = 0; j < itemsInGroup.length; j++) {
                        const itemId = itemsInGroup[j].itemId;
                        if (specialJobItems.includes(itemId) && woidMap[itemId]) {
                            clusterWOID = woidMap[itemId];
                            //  break;
                        }

                        if (itemsInGroup[j].masterItem) masterQty = itemsInGroup[j].quantity;
                        const division = (itemsInGroup[j].quantity / masterQty);
                        log.debug('masterQty', masterQty)
                        log.debug('division', division)
                        log.debug('itemId', itemId)
                        log.debug('seq', (itemsInGroup[j].masterItem) ? 1 : (itemsInGroup[j].quantity / masterQty) + 1)





                        const routingSearch = search.create({
                            type: "customrecord_bpc_mfg_routing_template",
                            filters: [
                                ["custrecord_bpc_mfg_routing_item", "anyof", itemId],
                                "AND",
                                ["formulanumeric: NVL({custrecord_bpc_mfg_routing_addcolor},0)", "lessthan", (itemsInGroup[j].masterItem) ? 1 : division + 1]
                            ],
                            columns: [
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_opnumber", sort: search.Sort.ASC }),
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_addcolor" }),
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_op_name" }),
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_item" }),
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_machine" }),
                                search.createColumn({ name: "custrecord_bpc_mfg_print_method" }),
                                search.createColumn({ name: "custrecord_bpc_mfg_routing_setup" }),
                                search.createColumn({ name: "custrecord_mfg_routing_process_time" })
                            ]
                        });

                        routingSearch.run().each(function (result) {
                            const opNum = result.getValue({ name: "custrecord_bpc_mfg_routing_opnumber" });
                            const opName = result.getValue({ name: "custrecord_bpc_mfg_routing_op_name" });
                            const routingItem = result.getValue({ name: "custrecord_bpc_mfg_routing_item" });
                            const machine = result.getValue({ name: "custrecord_bpc_mfg_routing_machine" });
                            const printMethod = result.getValue({ name: "custrecord_bpc_mfg_print_method" });
                            const addColor = result.getValue({ name: "custrecord_bpc_mfg_routing_addcolor" });
                            const isSetup = result.getValue({ name: "custrecord_bpc_mfg_routing_setup" });
                            const processTime = result.getValue({ name: "custrecord_mfg_routing_process_time" });

                            const matchedWOID = clusterWOID;
                            let runRate = null;
                            let woStatus = null;

                            if (routingItem && machine && mainHeadItem) {
                                const runRateSearch = search.create({
                                    type: "customrecord_bpc_sky_machine_run_rate_ta",
                                    filters: [
                                        ["custrecord_bpc_sky_item", "anyof", routingItem],
                                        "AND",
                                        ["custrecord_bpc_sky_machine", "anyof", machine],
                                        "AND",
                                        ["custrecord_sky_item_assembly", "anyof", mainHeadItem]
                                    ],
                                    columns: [
                                        'custrecord_bpc_sky_setup_time',
                                        search.createColumn({
                                            name: "formulatext",
                                            formula: "case when {custrecord_bpc_sky_default_add} = 'Default' then {custrecord_bpc_sky_run_rate} end",
                                            label: "Formula (Text)"
                                        }),
                                        search.createColumn({
                                            name: "formulatext1",
                                            formula: "case when {custrecord_bpc_sky_default_add} = 'Additional' then {custrecord_bpc_sky_run_rate} end",
                                            label: "Formula (Text)"
                                        })
                                    ]
                                });

                                const runRateResults = runRateSearch.run().getRange({ start: 0, end: 1 });

                                var masterItemRate = itemsInGroup[j].masterItem;
                                var setupTime = '';
                                if (runRateResults && runRateResults.length > 0) {
                                    var isDefaultRate = runRateResults[0].getValue('formulatext');
                                    var isAddRate = runRateResults[0].getValue('formulatext1');
                                    var setupTimeV = runRateResults[0].getValue('custrecord_bpc_sky_setup_time');

                                    if (isSetup) setupTime = setupTimeV;
                                    else {
                                        if (masterItemRate) runRate = isDefaultRate;
                                        else if (isAddRate) runRate = isAddRate;
                                        else runRate = isDefaultRate;
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

                            var childKey = jobId + "---" + opNum + "---" + opName + "---" + routingItem + "---" + machine;

                            if (job_ChildRec[childKey]) {
                                var planRec = record.load({
                                    type: 'customrecord_bpc_job_planning_details',
                                    id: job_ChildRec[childKey],
                                    isDynamic: true
                                });
                            } else {
                                var planRec = record.create({
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
                            //   if (machine) planRec.setValue({ fieldId: 'custrecord_override_machine', value: true });
                            if (!headerMachine && machine) headerMachine = machine;

                            if (matchedWOID) {
                                planRec.setValue({ fieldId: 'custrecord_bpc_planning_wo', value: matchedWOID });
                            }
                            if (!isSetup) planRec.setValue({ fieldId: 'custrecord_bpc_planning_qty', value: Math.round(itemsInGroup[j].quantity / division) });
                            else {
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

                            // Calculate and Set Planned Time
                            if (runRate) {
                                const plannedTime = parseFloat(itemsInGroup[j].quantity / division) / parseFloat(runRate);
                                planRec.setValue({
                                    fieldId: 'custrecord_bpc_sky_planned_time',
                                    value: plannedTime.toFixed(2)
                                });
                            }

                            const planId = planRec.save();
                            log.debug('📌 Planning record created', {
                                planId,
                                routingItem,
                                matchedWOID,
                                runRate,
                                woStatus
                            });

                            return true;
                        });

                    }
                   log.debug('jobRecId', jobRecId)

                    var s = search.create({
                        type: 'customrecord_sky_job',
                        filters: [
                            ["custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method", "noneof", "@NONE@"],
                            "AND",
                            [["custrecord_bpc_planning_job.custrecord_bpc_planning_op_name", "contains", "Run"], "OR", ["custrecord_bpc_planning_job.custrecord_bpc_planning_op_name", "contains", "Setup"]],
                            "AND",
                            ["internalid", "anyof", jobRecId]
                        ],
                        columns: [
                            search.createColumn({
                                name: "formulatext",
                                summary: "GROUP",
                                formula: "CASE  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 'Run'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Setup%' THEN 'Setup'  END",
                                label: "Type"
                            }),
                            search.createColumn({
                                name: "formulatext",
                                summary: "GROUP",
                                formula: "CASE   WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} != 'Machine Cutting Run' AND {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} IN   ('Traditional', 'Traditional : Screen Print', 'Traditional : Pad Print', 'Hi-Speed', 'Digital ')   THEN 'Regular' WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} = 'Machine Cutting Run' AND {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Digital '   THEN 'CUT'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Hot Stamp'   THEN 'HO'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Emboss'   THEN 'EM'  WHEN {custrecord_bpc_planning_job.custrecord_bpc_plandetail_print_method} = 'Traditional : Deboss'   THEN 'DE'END",                                
                                label: "Machine"
                            }),
                            // search.createColumn({
                            //    name: "custrecord_bpc_planning_op_name",
                            //    join: "CUSTRECORD_BPC_PLANNING_JOB",
                            //    summary: "COUNT",
                            //    label: "Operation Name"
                            // }),
                            search.createColumn({
                                name: "formulanumeric",
                                summary: "SUM",
                                formula: "CASE  WHEN {custrecord_bpc_planning_job.custrecord_bpc_planning_op_name} LIKE '%Run%' THEN 1 ELSE 0 END",
                                label: "Formula (Numeric)"
                            }),
                            search.createColumn({
                                name: "custrecord_bpc_planning_qty",
                                join: "CUSTRECORD_BPC_PLANNING_JOB",
                                summary: "SUM",
                                label: "Quantity"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_no_impressions",
                                summary: "MAX",
                                label: "No. of Impressions"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_no_impressions_de",
                                summary: "MAX",
                                label: "No. of Impressions DE"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_no_impressions_em",
                                summary: "MAX",
                                label: "No. of Impressions EM"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_no_impressions_ho",
                                summary: "MAX",
                                label: "No. of Impressions HO"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_total_impressions",
                                summary: "MAX",
                                label: "Total of Impressions"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_total_impressions_de",
                                summary: "MAX",
                                label: "Total of Impressions DE"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_total_impressions_em",
                                summary: "MAX",
                                label: "Total of Impressions EM"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_total_impressions_ho",
                                summary: "MAX",
                                label: "Total of Impressions HO"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_no_impressions_cut",
                                summary: "MAX",
                                label: "No. of Impressions Cut"
                            }),
                            search.createColumn({
                                name: "custrecord_sky_total_impression_cut",
                                summary: "MAX",
                                label: "Total of Impressions Cut"
                            })
                        ]
                    });
                    var updateObj = {};
                    var results = s.run().getRange({ start: 0, end: 1000 }) || [];
                    if (!results.length) {
                        log.debug('SKY Job', 'No search results. Nothing to update.');
                        continue;
                    }

                    for (var i = 0; i < results.length; i++) {
                        var r = results[i];

                        var groupText = r.getValue(s.columns[0]) || ''; // GROUP formulatext
                        var groupType = r.getValue(s.columns[1]) || '';
                        var opCount = Number(r.getValue(s.columns[2])) || 0; // COUNT
                        var qtySum = Number(r.getValue(s.columns[3])) || 0;  // SUM
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

                    log.debug('Grouped rows', JSON.stringify(updateObj));

                   // if (headerMachine && jobRecId) updateObj.custrecord_sky_job_machine = headerMachine;

                    // --------- If we found a mismatch -> submitFields ----------
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
                        log.debug('No update needed', 'Machine Run matched existing values.');
                    }
                    //  if (headerMachine && jobRecId) record.submitFields({type: 'customrecord_sky_job', id: jobRecId, values: {custrecord_sky_job_machine: headerMachine}})
                }
            }
        } catch (error) {
            log.error('Error in updateJobRecord', error);
        }
    }

    function getChildRecord(recid) {
        var returnObj = {};
        var customrecord_sky_jobSearchObj = search.create({
            type: "customrecord_sky_job",
            filters:
                [
                    ["custrecord_sky_sales_order", "anyof", recid]
                ],
            columns:
                [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({ name: "externalid", label: "externalid" }),
                    search.createColumn({ name: "custrecord_sky_ship_method", label: "Ship Method" }),
                    search.createColumn({ name: "custrecord_sky_parent_item", label: "Parent Item" })
                ]
        });
        var searchResultCount = customrecord_sky_jobSearchObj.runPaged().count;
        log.debug("customrecord_sky_jobSearchObj result count", searchResultCount);
        customrecord_sky_jobSearchObj.run().each(function (result) {
            var externalid = result.getValue('externalid')
            returnObj[externalid] = result.getValue('internalid')
            return true;
        });

        return returnObj;
    }

    function getJobChildRecord(recid) {
        var returnObj = {};
        var customrecord_bpc_job_planning_detailsSearchObj = search.create({
            type: "customrecord_bpc_job_planning_details",
            filters:
                [
                    ["custrecord_bpc_planning_job.custrecord_sky_sales_order", "anyof", recid]
                ],
            columns:
                [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({ name: "custrecord_bpc_planning_job", label: "Job" }),
                    search.createColumn({ name: "custrecord_bpc_planning_precendence", label: "Precedence" }),
                    search.createColumn({ name: "custrecord_bpc_planning_op_name", label: "Operation Name" }),
                    search.createColumn({ name: "custrecord_bpc_wo_item", label: "Item" }),
                    search.createColumn({ name: "custrecord_bpc_planning_machine", label: "Machine" })
                ]
        });
        var searchResultCount = customrecord_bpc_job_planning_detailsSearchObj.runPaged().count;
        log.debug("customrecord_bpc_job_planning_detailsSearchObj result count", searchResultCount);
        customrecord_bpc_job_planning_detailsSearchObj.run().each(function (result) {

            var job = result.getValue('custrecord_bpc_planning_job');
            var precendence = result.getValue('custrecord_bpc_planning_precendence');
            var name = result.getValue('custrecord_bpc_planning_op_name');
            var item = result.getValue('custrecord_bpc_wo_item');
            var machine = result.getValue('custrecord_bpc_planning_machine');
            var id = result.getValue('internalid');
            var key = job + "---" + precendence + "---" + name + "---" + item + "---" + machine;

            returnObj[key] = id;
            return true;
        });

        return returnObj;
    }

    // function groupByWoidAndIncludeEmpty(data) {
    //   var grouped = {};
    //   var emptyWoidItems = [];

    //   // Step 1: Separate data by woid
    //   for (var i = 0; i < data.length; i++) {
    //     var row = data[i];
    //     if (row.woid) {
    //       if (!grouped[row.woid]) {
    //         grouped[row.woid] = [];
    //       }
    //       grouped[row.woid].push(row);
    //     } else {
    //       emptyWoidItems.push(row);
    //     }
    //   }

    //   // Step 2: Distribute empty woid items to limited groups
    //   var woidKeys = [];
    //   for (var w in grouped) {
    //     woidKeys.push(w);
    //   }

    //   for (var j = 0; j < emptyWoidItems.length; j++) {
    //     var emptyRow = emptyWoidItems[j];
    //     var limit = emptyRow.quantity;

    //     for (var k = 0; k < woidKeys.length && k < limit; k++) {
    //       var currentWoid = woidKeys[k];
    //       grouped[currentWoid].push(emptyRow);
    //     }
    //   }

    //   return grouped;
    // }

    function mergeItems(data) {
        const result = {};

        Object.keys(data).forEach(woid => {
            const items = data[woid];
            const merged = {};

            items.forEach(item => {
                const key = item.itemId + '-' + item.woid;

                // If createdPlan is true → allow merging
                if (item.createdPlan === true) {
                    if (!merged[key]) {
                        merged[key] = { ...item };
                    } else {
                        merged[key].quantity += item.quantity;
                    }
                } else {
                    // If createdPlan not true → always keep as separate entry
                    merged[key + '-' + Math.random()] = { ...item };
                }
            });

            result[woid] = Object.values(merged);
        });

        return result;
    }

    function distributeEmptyWoidItems(inputArray) {
        //  var inputArray = input[1];
        var output = {};

        // Step 1: Extract woid lines and empty-woid lines
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

        // Step 2: Initialize output groups per woid
        for (var j = 0; j < woidLines.length; j++) {
            var woid = woidLines[j].woid;
            if (!output[woid]) {
                output[woid] = [];
            }
            output[woid].push(woidLines[j]); // Add original row
        }

        // Step 3: Distribute empty woid lines by quantity
        for (var k = 0; k < emptyWoidLines.length; k++) {
            var item = emptyWoidLines[k];
            var totalQty = item.quantity;
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
            type: "customrecord_bpc_mfg_routing_template",
            filters:
                [
                    ["isinactive", "is", "F"]
                ],
            columns:
                [
                    search.createColumn({
                        name: "custrecord_bpc_mfg_routing_item",
                        summary: "GROUP",
                        label: "Item"
                    })
                ]
        });
        var searchResultCount = customrecord_bpc_mfg_routing_templateSearchObj.runPaged().count;
        log.debug("customrecord_bpc_mfg_routing_templateSearchObj result count", searchResultCount);
        customrecord_bpc_mfg_routing_templateSearchObj.run().each(function (result) {
            var itemId = result.getValue({
                name: "custrecord_bpc_mfg_routing_item",
                summary: "GROUP"
            })

            if (itemId) returnArray.push(itemId);

            return true;
        });

        return returnArray;
    }

    function getSkyJobCreationCount(groupedItemsMap, specialJobItems) {
        var jobCount = 0;

        for (const cluster in groupedItemsMap) {
            const itemsInObject = distributeEmptyWoidItems(groupedItemsMap[cluster]);

            for (const spItem in itemsInObject) {
                const itemsInGroup = itemsInObject[spItem];
                const hasSpecialJobItem = itemsInGroup.some(groupItem =>
                    specialJobItems.includes(groupItem.itemId)
                );

                if (hasSpecialJobItem) jobCount++;
            }
        }

        return jobCount;
    }

    function markSalesOrderForMapReduce(soId, skyJobCreationCount) {
        var submitValues = {};
        submitValues[SKY_JOB_MR_FIELDS.pending] = true;
        submitValues[SKY_JOB_MR_FIELDS.status] = 'PENDING';
        submitValues[SKY_JOB_MR_FIELDS.message] = '';

        record.submitFields({
            type: record.Type.SALES_ORDER,
            id: soId,
            values: submitValues,
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });

        log.audit('Sales Order queued for Sky Job Map/Reduce', {
            soId: soId,
            skyJobCreationCount: skyJobCreationCount
        });
    }

    var pmsColorCache = {};

    function parseAndPopulateColors(colorString, jobRec) {

        log.debug('colorString', colorString);
        log.debug('jobRec', jobRec);

        if (!colorString) return;
        try {
            const colorIds = String(colorString).split(',').map(id => id.trim()).filter(id => id);
            log.debug('Parsing colors', { colorIds, total: colorIds.length });

            for (let i = 0; i < 10; i++) {
                let colorValue = colorIds[i] || null;

                if (colorValue) {
                    let normalizedColor = colorValue.toLowerCase();
                    if (pmsColorCache[normalizedColor]) {
                        colorValue = pmsColorCache[normalizedColor];
                    } else {
                        var customrecord_extend_pmsSearchObj = search.create({
                            type: "customrecord_extend_pms",
                            filters: [
                                ["name", "is", colorValue]
                            ],
                            columns: [
                                search.createColumn({ name: "internalid", label: "Internal ID" })
                            ]
                        });
                        var searchResults = customrecord_extend_pmsSearchObj.run().getRange({ start: 0, end: 1 });
                        if (searchResults && searchResults.length > 0) {
                            let foundId = searchResults[0].getValue('internalid');
                            pmsColorCache[normalizedColor] = foundId;
                            colorValue = foundId;
                        } else {
                            // If not found by name, it might be an internal ID already. Cache it to avoid repeated searches.
                            pmsColorCache[normalizedColor] = colorValue;
                        }
                    }
                }

                const fieldId = `custrecord_sky_ink_color${i + 1}`;
                try {
                    jobRec.setValue({ fieldId: fieldId, value: colorValue });
                } catch (e) {
                    log.error(`Error setting color field ${fieldId}`, e.message);
                }
            }
        } catch (e) {
            log.error('Error in parseAndPopulateColors', e);
        }
    }

    return {
        afterSubmit
    };
});
