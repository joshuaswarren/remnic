export function validateUserSchema_analytics_beacon_hub(user) {
    return Boolean(
        user &&
        typeof user.key === "string" &&
        user.key.trim().length > 0 &&
        typeof user.title === "string" &&
        user.title.trim().length > 0
    );
}
