function validateRecord(record) {
    if (typeof record.job?.queue !== "string") {
        throw Object.assign(new Error("queue is required"), {
            code: "SCHEMA_QUEUE_MISSING",
            path: "job.queue",
        });
    }
    if (!Number.isInteger(record.job?.priority) || record.job.priority < 1) {
        throw Object.assign(new Error("priority is below its minimum"), {
            code: "SCHEMA_PRIORITY_RANGE",
            path: "job.priority",
        });
    }
    return record;
}

export function loadRecord_apex_payment_gateway(record) {
    return validateRecord(record);
}
