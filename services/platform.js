function requestPlatform(req) {
    const value = req.get('X-App-Platform') || req.query?.platform;
    return ['ios', 'android', 'macos', 'windows'].includes(value) ? value : undefined;
}
module.exports = { requestPlatform };
