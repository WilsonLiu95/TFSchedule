const schedule = require('node-schedule');
const parser = require('cron-parser');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
const co = require('co');
var eventEmitter;
// 小助手1：已存在的任务：数据库更新rule，cancel定时任务 并设置挂载新规则的定时任务；新增任务：按照rule进行挂载
function* checkLoadTask({ task_name, rule }, app, taskExecFunc) {
    var { G_child_process_hanlde_map, G_task_map, G_pool_client, G_task_schedule_list } = app;

    if (G_task_map[task_name]) {
        // 比较内存中对应任务的规则与数据库中的是否一致，不一致则cancel之前的任务并进行重启
        if (G_task_map[task_name] == rule) {
            return false;
        }

        // 注： cancel时并不影响当前任务的运行，当前任务仍然会继续执行完成再退出。而新的任务因为老的任务没有关闭，并不会重启，需要等待老任务结束    
        console.log(`(${task_name})-规则更新，${G_task_map[task_name]} -> ${rule},重新挂载该任务的定时器`);
        G_task_map[task_name] = rule; // 更新
        G_task_schedule_list[task_name].cancel();
        delete G_task_schedule_list[task_name];
        

        // 重新进行挂载任务
        G_task_schedule_list[task_name] = schedule.scheduleJob(rule, taskExecFunc);
    } else {
        // 新增的任务，直接进行挂载
        G_task_map[task_name] = rule; // 新增task
        console.log(`(${task_name})-新增任务，将该任务挂载定时器`);
        G_task_schedule_list[task_name] = schedule.scheduleJob(rule, taskExecFunc);
    }
}
// 小助手2：用户设置task_status为2，则杀死当前进程,
function* checkIsKillTask(taskInfo, { G_child_process_hanlde_map, G_pool_client }) {
    var { task_name, last_warning_time, task_status } = taskInfo;
    if (task_status === 2) {
        // 超时发送告警
        var sql;
        if (G_child_process_hanlde_map[task_name]) {
            console.log(`(${task_name})-触发小助手2：${JSON.stringify(taskInfo)}`);
            G_child_process_hanlde_map[task_name].kill('SIGHUP');
            delete G_child_process_hanlde_map[task_name];
            const content = `(${task_name})-task_status:${task_status}，小助手为您杀死运行该任务的进程`;
            eventEmitter.emit('waring', { task_name, content })

            sql = `update t_task_list set task_status=1 where task_name='${task_name}'`;
            console.log(`${content}--(sql:${sql})`);
            // task_status状态2位短暂状态，杀死后恢复为1，表示无效
            yield G_pool_client.query(sql);
        }
    }
}
// 小助手3：根据数据库中的timeout字段，进行超时提醒
function* checkTaskOutTime(taskInfo, { G_child_process_hanlde_map }) {
    var { task_name, last_start_time, timeout, last_end_time, last_warning_time } = taskInfo;

    // 判断任务执行是否超时首先需要满足DB与memory同时标记任务正在运行，以避免取DB时last_start_time尚未更新，导致错误告警
    const db_isLastTaskExecEnd = moment(last_end_time).diff(moment(last_start_time), 'seconds') >= 0;
    const memory_isHasExecingTaskProcees = G_child_process_hanlde_map[task_name];
    if (db_isLastTaskExecEnd || !memory_isHasExecingTaskProcees) {
        return false;
    }
    timeout = timeout || 60; // 默认60S超时

    var deadline = moment(last_start_time).add(timeout, 's');
    var isHasPassDeadLine = moment().isAfter(deadline);
    var isHasWarningUser = moment(last_warning_time).isAfter(last_start_time);

    // 超时且尚未发送过警告，则进行告警
    if (isHasPassDeadLine && !isHasWarningUser) {
        console.log(`(${task_name})-触发小助手3：${JSON.stringify(taskInfo)}`);
        var last_start_time_str = moment(last_start_time).format('YYYY-MM-DD HH:mm:ss');
        var dead_time_str = moment(deadline).format('YYYY-MM-DD HH:mm:ss');

        var content = `(${task_name})-${moment().format('YYYY-MM-DD HH:mm:ss')} 任务超时,开始时间${last_start_time_str},dealine为${dead_time_str}`;

        eventEmitter.emit('waring', { task_name, content });
    }
}

// 小助手4： 任务漏执行，告警通知
function* checkIsPassExec(taskInfo, { G_child_process_hanlde_map }) {
    const { task_name, rule, last_start_time, last_end_time, last_warning_time, task_status } = taskInfo;
    if (task_status !== 0) { // 只对有效状态的任务进行检测
        return false;
    }
    try {
        const db_isLastTaskExecEnd = moment(last_end_time).diff(moment(last_start_time), 'seconds') >= 0;
        const memory_isHasExecingTaskProcees = G_child_process_hanlde_map[task_name];
        // 只有在DB与内存中同时标记当前无正在运行的任务时，才进行告警检验
        if (!memory_isHasExecingTaskProcees && db_isLastTaskExecEnd) {
            const intervalHandle = parser.parseExpression(rule); // 解析规则，获取crontab rule句柄
            const lastShouldExecTime = intervalHandle.prev().toDate();
            const lastStartTimeIsNotShouldExecTime = moment(last_start_time).diff(moment(lastShouldExecTime), 'seconds') < 0; // 上次执行时间在规则的上个执行时间之前
            const isHasPassShouldExecTime = moment().diff(moment(lastShouldExecTime), 'seconds') >= 3; // 现在时间已经过了上次该执行的时间
            const isHasWaring = moment(last_warning_time).isAfter(lastShouldExecTime);

            // 判断任务是否漏执行：1. crontab规则上次触发时间不再在上次任务执行时间之前 2. 现在已经过了该执行时间之后3S
            // 未告警则进行告警，告警过则忽略
            if (lastStartTimeIsNotShouldExecTime && isHasPassShouldExecTime && !isHasWaring) {
                console.log(`(${task_name})-触发小助手4：${JSON.stringify(taskInfo)}`);
                console.log(`lastStartTimeIsNotShouldExecTime:${moment(last_start_time).diff(moment(lastShouldExecTime), 'seconds')}`);
                console.log(`isHasPassShouldExecTime:${moment().diff(moment(lastShouldExecTime), 'seconds')}`);
                var content = `(${task_name})-任务在${moment(lastShouldExecTime).format('YYYY-MM-DD HH:mm:ss')}漏执行，请关注，如果是因为任务被设置为无效导致，请忽略`;
                eventEmitter.emit('waring', { task_name, content });
            }
        }
    } catch (e) {
        eventEmitter.emit('waring', { task_name, title: `${task_name}cron-parser解析出错啦`, content: e.toString() });
    }
}

// 小助手5： 任务在数据库中被删除告警用户
function* checkTaskIsDelete(task_name, app) {
    var { G_child_process_hanlde_map, G_task_map, G_pool_client } = app;
    var sql = `select * from t_task_list where task_name='${task_name}'`;
    var data = yield G_pool_client.query(sql);
    if (data.length === 0) {
        eventEmitter.emit('waring', { task_name, title: `(${task_name})-数据库该任务记录被删除，请关注`, });
        delete G_task_map[task_name];
    }
}

// 小助手6： 手动执行任务
function* checkIsRunTaskAgain({ task_name, task_status }, { G_pool_client }, taskExecFunc) {
    if (task_status == 3) {
        var sql = `update t_task_list set task_status=0 where task_name='${task_name}'`;
        console.log(`(${task_name})-小助手6 checkIsRunTaskAgain -${sql}`);
        yield G_pool_client.query(sql);
        taskExecFunc && taskExecFunc();
    }
}
// 小助手3S运行一次，进行监控
function* __monitorHelper(app) {
    const { G_pool_client, G_task_map, execTask } = app;
    // load当前db中最新的数据
    var db_current_task_list = yield G_pool_client.query(`select * from t_task_list`)

    // 小助手5： 任务被删除告警
    yield Object.keys(G_task_map).map(task_name => {
        return checkTaskIsDelete(task_name, app);
    });

    yield db_current_task_list.map(taskInfo => {
        return function* () {
            // 小助手1：任务rule修改与新增任务 进行定时器挂载
            yield checkLoadTask(taskInfo, app, function () {
                var { task_name } = taskInfo;
                execTask(task_name, app);
            });

            yield checkIsKillTask(taskInfo, app); // 小助手2：校验是否杀死进程
            yield checkIsPassExec(taskInfo, app); // 小助手3：检验任务是否漏执行
            yield checkTaskOutTime(taskInfo, app); // 小助手4： 检验任务是否允许超时
            yield checkIsRunTaskAgain(taskInfo, app, function () { // 小助手6：用户手动设置状态为3，则再次执行一次任务，并将任务状态置为0
                var { task_name } = taskInfo;
                execTask(task_name, app);    
            });
        };
    });
}

// 封装成promise对外
const monitorHelper = co.wrap(function* (app) {
    eventEmitter = app.eventEmitter;
    try {
        yield __monitorHelper(app);
        return Promise.resolve();
    } catch (e) {
        console.error(e);
        return Promise.reject(e);
    }
});
module.exports = {
    monitorHelper
}