const moment = require('moment');
const path = require('path');
const fs = require('fs-extra');
const spawn = require('child_process').spawn;
const co = require('co');

// 执行一次任务
function* __execTask(task_name, app) {
    var { G_pool_client,G_child_process_hanlde_map } = app;
    // 1: 数据库查询该条任务,
    var data = yield G_pool_client.query(`select * from t_task_list where task_name='${task_name}'`);
    if (data.length == 0) {
        console.log(`(${task_name})-任务在数据库中已被删除，不再执行该任务`);
        return false;
    }
    const taskInfo = data[0];

    // 2. 检验该任务是否可以创建新的进程运行
    if (!checkIsNewTaskProcess(taskInfo,G_child_process_hanlde_map)) return false;

    // 3. 使用子进程spawn接口运行任务
    yield spawnTask(taskInfo, app);

}
var execTask = co.wrap(function* (task_name,app) {
    try {
        yield __execTask(task_name,app);
        return Promise.resolve();
    } catch (e) {
        console.error(e);
        return Promise.reject(e);
    }
});
// 使用子进程spawn接口运行任务
function* spawnTask(taskInfo, app) {
    var { G_child_process_hanlde_map, task_root_path, eventEmitter } = app;
    var { task_name } = taskInfo;
    var error_log_list = [];

    const task_version = moment().format('YYYYMM/DD/HHmmss'); // 当前任务的版本号
    const taskExecFilePath = path.join(task_root_path, task_name, 'index.js');
    const task_log_file = path.join(task_root_path, task_name, `logs/${task_version}.log`);

    // 检验任务入口文件是否存在，不存在则返回
    if (!checkExecFileExists(taskInfo, taskExecFilePath, app)) return false;

    // 调用 任务开始运行的钩子函数
    eventEmitter.emit('task_start', { task_name, task_version }, app);

    G_child_process_hanlde_map[task_name] = spawn('node', [taskExecFilePath]);

    const task_pid = `(pid:${G_child_process_hanlde_map[task_name].pid})`;

    fs.ensureFileSync(task_log_file);

    // stdout输出到任务日志
    G_child_process_hanlde_map[task_name].stdout.on('data', function (data) {
        var log_info = `${moment().format('YYYY-MM-DD HH:mm:ss')} stdout-${task_pid}: ${(new Buffer(data)).toString()}`;
        fs.appendFileSync(task_log_file, log_info);
    });

    // stderr输出到任务日志
    G_child_process_hanlde_map[task_name].stderr.on('data', function (data) {
        var log_info = `${moment().format('YYYY-MM-DD HH:mm:ss')} stderr-${task_pid} ${(new Buffer(data)).toString()}`;
        // 为了保护自身对异常日志进行限制，DB只保存不超过100条的异常日志
        if (error_log_list.length < 100) {
            error_log_list.push(log_info);
        }

        fs.appendFileSync(task_log_file, log_info);
    });

    G_child_process_hanlde_map[task_name].on('close', function (exit_code, signalCode) {
        var content;
        if (signalCode) {
            exit_code = 2; // 主动被杀死状态码为2
            content = `(${task_name})-${task_pid}任务状态码task_status=2，父进程主动杀死子进程`;
        } else {
            content = `(${task_name})-${task_pid}运行结束，退出码为${exit_code}`;
        }

        console.log(content);
        // 结束状态输出到任务日志
        fs.appendFileSync(task_log_file, `${content}\n===========任务结束==========\n`);

        // 删除子进程句柄的引用，以释放内存
        delete G_child_process_hanlde_map[task_name];
        eventEmitter.emit('task_end', { task_name, exit_code, task_version, error_log_list }, app);
    });
}

// 判断任务入口文件是否存在，不存在则停止执行并告警
function checkExecFileExists({ task_name, last_warning_time, last_start_time }, taskExecFilePath, { eventEmitter }) {
    const isTaskExecFileExists = fs.existsSync(taskExecFilePath);

    if (!isTaskExecFileExists) { // 任务入口文件不存在，结束执行
        var isHasWarningUser = moment(last_warning_time).isAfter(last_start_time);
        if (!isHasWarningUser) {
            eventEmitter.emit('waring', { title: `${task_name}-任务入口执行文件不存在`, task_name })
        }
        return false;
    }
    return true;
}

/**
 * 检验是否可以新建进程 
 * 1. task_status为0
 * 2. 本任务上一次执行的进程已结束
 */
function checkIsNewTaskProcess({task_name, task_status },G_child_process_hanlde_map) {
    if (G_child_process_hanlde_map[task_name]) { // 上一个任务子进程尚未退出
        console.log(`(${task_name})-(pid:${G_child_process_hanlde_map[task_name].pid})-任务当前正在执行未退出`);
        return false;
    }
    if (task_status !== 0) {
        console.log(`(${task_name})-任务被设置为无效状态码task_status:${task_status}，不执行`);
        return false;
    }
    return true
}

module.exports = {
    execTask
}