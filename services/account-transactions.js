const { AsyncLocalStorage } = require('node:async_hooks');
// A query-scoped session keeps legacy credit helpers in the same transaction.
// Never use a global MongoDB session: parallel HTTP requests must stay isolated.
function createAccountTransactions(Account, Backup) {
    const scope = new AsyncLocalStorage();
    async function run(work) {
        if (scope.getStore()) return work();
        await Backup.init();
        for (let attempt = 0; ; attempt++) {
            const session = await Account.db.startSession();
            try { return await session.withTransaction(() => scope.run(session, work)); }
            catch (error) { if (error.code !== 11000 || attempt >= 9) throw error; }
            finally { await session.endSession(); }
        }
    }
    function bind(Model) {
        const queries = new Set(['findOne', 'findById', 'find', 'findOneAndUpdate', 'updateOne', 'updateMany', 'exists']);
        return new Proxy(Model, { get(target, property) {
            if (queries.has(property)) return (...args) => {
                const query = target[property](...args);
                const session = scope.getStore();
                return session ? query.session(session) : query;
            };
            if (property === 'create') return async docs => {
                const session = scope.getStore();
                if (!session) return target.create(docs);
                const results = await target.create(Array.isArray(docs) ? docs : [docs], { session });
                return Array.isArray(docs) ? results : results[0];
            };
            return Reflect.get(target, property);
        } });
    }
    return { run, bind, session: () => scope.getStore() };
}
module.exports = { createAccountTransactions };
