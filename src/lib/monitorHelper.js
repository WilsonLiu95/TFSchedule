const {
    scheduleJob
} = require('node-schedule');
const parser = require('cron-parser');
const moment = require('moment');
// 小助手1：已存在的任务：数据库更新rule，cancel定时任务 并设置挂载新规则的定时任务；新增任务：按照rule进行挂载
function* checkLoadTask({
    taskName,
    rule,
    title
}) {
    var {
        taskRuleMap,
        scheduledJobs
    } = this;
    if (taskRuleMap[taskName] && taskRuleMap[taskName] === rule) {
        return false;
    }
    if (!taskRuleMap[taskName]) {
        // 新增的任务，直接进行挂载
        this.emit('taskLevelNotify', {
            type: 'addTask',
            taskName,
            rule,
            title: `${taskName} ${title} (addTask)`,
            content: `新增任务按照规则${rule}挂载`
        });
    } else {
        // 比较内存中对应任务的规则与数据库中的是否一致，不一致则cancel之前的任务并进行重启
        // 注： cancel时并不影响当前任务的运行，当前任务仍然会继续执行完成再退出。而新的任务因为老的任务没有关闭，并不会重启，需要等待老任务结束
        scheduledJobs[taskName].cancel();
        const oldRule = taskRuleMap[taskName];
        this.emit('taskLevelNotify', {
            type: 'modifyTask',
            taskName,
            oldRule,
            newRule: rule,
            title: `${taskName} ${title} (modifyTask)`,
            content: `${taskRuleMap[taskName]} -> ${rule},重新挂载该任务的定时器`
        });
    }
    // 重新进行挂载任务
    taskRuleMap[taskName] = rule;
    scheduleJob(taskName, rule, () => {
        try {
            this.emit('runTask', [taskName]);
        } catch (e) {
            this.throwError('checkLoadTask run task', e);
        }
    });
}
// 小助手2：用户设置taskStatus为2，则杀死当前进程,
function* checkIsKillTask(taskInfo) {
    var {
        mysqlClient,
        childProcessHandleCache
    } = this;
    var {
        taskName,
        taskStatus,
        taskVersion,
        title
    } = taskInfo;
    if (taskStatus === 2) {
        console.log(`(${taskName})-触发小助手2：${JSON.stringify(taskInfo)}`);
        // 超时发送告警
        if (childProcessHandleCache[taskName]) {
            childProcessHandleCache[taskName].kill('SIGHUP');
            delete childProcessHandleCache[taskName];
            this.emit('taskLevelNotify', {
                type: 'killTask',
                taskName,
                taskVersion,
                title: `${taskName} ${title} (killTask)`,
                content: '任务被手动杀死'
            });
        }
        // taskStatus状态2位短暂状态，杀死后恢复为1，表示无效
        yield mysqlClient.query(`update t_task_list set taskStatus=1 where taskName='${taskName}'`);
    }
}
// 小助手3：根据数据库中的timeout字段，进行超时提醒
function* checkTaskOutTime(taskInfo) {
    var {
        childProcessHandleCache
    } = this;
    var {
        taskName,
        lastStartTime,
        timeout,
        lastEndTime,
        lastWarningTime,
        taskVersion,
        title
    } = taskInfo;

    // 判断任务执行是否超时首先需要满足DB与memory同时标记任务正在运行，以避免取DB时lastStartTime尚未更新，导致错误告警
    const dbIsLastTaskExecEnd = moment(lastEndTime).diff(moment(lastStartTime), 'seconds') >= 0;
    const memoryIsHasExecingTaskProcees = childProcessHandleCache[taskName];
    if (dbIsLastTaskExecEnd || !memoryIsHasExecingTaskProcees) {
        return false;
    }
    timeout = timeout || 60; // 默认60S超时

    var deadline = moment(lastStartTime).add(timeout, 's');
    var isHasPassDeadLine = moment().isAfter(deadline);
    var isHasWarningUser = moment(lastWarningTime).isAfter(lastStartTime);

    // 超时且尚未发送过警告，则进行告警
    if (isHasPassDeadLine && !isHasWarningUser) {
        console.log(`(${taskName})-触发小助手3：${JSON.stringify(taskInfo)}`);
        const lastStartTimeStr = moment(lastStartTime).format('YYYY-MM-DD HH:mm:ss');
        const deadTimeStr = moment(deadline).format('YYYY-MM-DD HH:mm:ss');

        this.emit('taskLevelNotify', {
            type: 'outtimeTask',
            taskName,
            taskVersion,
            title: `${taskName} ${title} (outtimeTask)`,
            content: `任务超时设置时间为${timeout}秒，本次任务开始时间${lastStartTimeStr}, 截止目前${deadTimeStr}，执行任务超时`
        });
    }
}

// 小助手4： 任务漏执行，告警通知
function* checkIsPassExec(taskInfo) {
    var {
        childProcessHandleCache
    } = this;
    const {
        taskName,
        rule,
        lastStartTime,
        lastEndTime,
        lastWarningTime,
        taskStatus,
        title
    } = taskInfo;
    // 只对有效状态的任务进行检测
    if (taskStatus !== 0) {
        return false;
    }
    try {
        const dbIsLastTaskExecEnd = moment(lastEndTime).diff(moment(lastStartTime), 'seconds') >= 0;
        const memoryIsHasExecingTaskProcees = childProcessHandleCache[taskName];
        // 只有在DB与内存中同时标记当前无正在运行的任务时，才进行告警检验
        if (!memoryIsHasExecingTaskProcees && dbIsLastTaskExecEnd) {
            const intervalHandle = parser.parseExpression(rule); // 解析规则，获取crontab rule句柄
            const lastShouldExecTime = intervalHandle.prev().toDate();
            const lastStartTimeIsNotShouldExecTime = moment(lastStartTime).diff(moment(lastShouldExecTime), 'seconds') < 0; // 上次执行时间在规则的上个执行时间之前
            const isHasPassShouldExecTime = moment().diff(moment(lastShouldExecTime), 'seconds') >= 3; // 现在时间已经过了上次该执行的时间
            const isHasWaring = moment(lastWarningTime).isAfter(lastShouldExecTime);

            // 判断任务是否漏执行：1. crontab规则上次触发时间不再在上次任务执行时间之前 2. 现在已经过了该执行时间之后3S
            // 未告警则进行告警，告警过则忽略
            if (lastStartTimeIsNotShouldExecTime && isHasPassShouldExecTime && !isHasWaring) {
                this.emit('taskLevelNotify', {
                    type: 'missrunTask',
                    taskName,
                    title: `${taskName} ${title} (missrunTask)`,
                    content: `任务漏执行，上次任务本该在:${moment(lastShouldExecTime).diff(moment(lastStartTime), 'seconds')}S前的${moment(lastShouldExecTime).format('YYYY-MM-DD HH:mm:ss')}执行;请关注，如果是因为任务被设置为无效导致，请忽略`
                });
            }
        }
    } catch (e) {
        this.throwError(`${taskName}cron-parser解析出错啦`, e);
    }
}

// 小助手5： 任务在数据库中被删除告警用户
function checkTaskIsDelete(dbCurrentTaskList) {
    var { taskRuleMap } = this;
    var deleteTaskList = [];
    Object.keys(taskRuleMap).map(taskName => {
        var isExistsTask = false;
        dbCurrentTaskList.forEach(el => {
            if (el.taskName === taskName) {
                isExistsTask = true;
            }
        });
        if (!isExistsTask) {
            deleteTaskList.push(taskName);
            delete taskRuleMap[taskName];
        }
    });

    deleteTaskList.length && this.emit('taskLevelNotify', {
        type: 'taskDelete',
        taskName: deleteTaskList.join(','),
        title: `${deleteTaskList.join(',')} (taskDelete)`,
        content: '任务被删除，请关注'
    });
}

// 小助手6： 手动执行任务
function* checkIsRunTaskAgain({
    taskName,
    taskStatus
}) {
    var {
        mysqlClient
    } = this;
    if (taskStatus === 3) {
        console.log(`(${taskName})-小助手6 手动调用任务`);
        yield mysqlClient.query(`update t_task_list set taskStatus=0 where taskName='${taskName}'`);
        this.emit('runTask', taskName);
    }
}
// 小助手3S运行一次，进行监控
function* monitorHelper() {
    var that = this;
    var {
        mysqlClient
    } = this;
    try {
        const monitorStartTime = Date.now();
        var timeList = [];
        const dbCurrentTaskList = yield mysqlClient.query('select * from t_task_list');
        timeList.push(Date.now() - monitorStartTime);
        // 小助手5： 任务被删除告警
        checkTaskIsDelete.apply(that, [dbCurrentTaskList]);
        timeList.push(Date.now() - monitorStartTime);
        yield dbCurrentTaskList.map(function* (taskInfo) {
            // 并发执行
            yield ([
                checkLoadTask.apply(that, [taskInfo]), // 小助手1：任务rule修改与新增任务 进行定时器挂载
                checkIsKillTask.apply(that, [taskInfo]), // 小助手2：校验是否杀死进程
                checkIsPassExec.apply(that, [taskInfo]), // 小助手3：检验任务是否漏执行
                checkTaskOutTime.apply(that, [taskInfo]), // 小助手4： 检验任务是否允许超时
                checkIsRunTaskAgain.apply(that, [taskInfo]) // 小助手6： 手动执行任务
            ]);
        });
        const duration = Date.now() - monitorStartTime;
        if (duration > 1000) { // 如果执行时间超过1S则输出标记
            timeList.push(duration);
            console.log(`(monitorHelper)本次监控小助手-执行完成,耗时 ${timeList.join(',')} 毫秒`);
        }
    } catch (e) {
        this.throwError('monitorHelper', e);
    }
}

module.exports = {
    monitorHelper
};
