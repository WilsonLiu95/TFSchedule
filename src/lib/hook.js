/*
    @filename: hook.js 
    @author: wilsonsliu(wilsonsliu@tencent.com)
    @intro: 批跑系统执行的钩子函数，包括任务开始与结束
*/

const path = require('path');
const moment = require('moment');
const fs = require('fs-extra');
const dir = require('node-dir');
const co = require('co');
const mysql = require('promise-mysql');

// 任务开始执行的钩子函数
function* startExecTask({ task_name, task_version }, { G_pool_client, task_root_path }) {
    var now_time_str = moment().format('YYYY-MM-DD HH:mm:ss');

    // 1. 置空发布文件夹
    var task_publish_dir = path.join(task_root_path, task_name, 'publish');
    fs.emptyDirSync(task_publish_dir);


    // 2. 更新任务表中的last_start_time与task_version
    var sql = `update t_task_list SET last_start_time='${now_time_str}', task_version='${task_version}' where task_name = '${task_name}'`;
    yield G_pool_client.query(sql);

    // 3. 插入一条任务执行记录
    var sql2 = `INSERT INTO t_task_exec_list (task_name, task_version, start_time) VALUES ('${task_name}','${task_version}', '${now_time_str}')`;
    yield G_pool_client.query(sql2);
}


// 任务执行结束的钩子函数
function* endExecTask({ task_name, exit_code, task_version, error_log_list }, { G_pool_client, eventEmitter, task_root_path }) {
    var task_publish_dir = path.join(task_root_path, task_name, 'publish');;
    var now_time_str = moment().format('YYYY-MM-DD HH:mm:ss');
    // 1. 设置退出的事件与退出码
    var sql = `update t_task_list SET last_end_time='${now_time_str}',last_exit_code=${exit_code} where task_name = '${task_name}'`;
    yield G_pool_client.query(sql);

    if (exit_code != 0) { // 任务执行成功
        eventEmitter.emit('waring', { task_name, content: error_log_list.join('\n'), title: `批跑任务${task_name}未通过,退出错误码：exit_code:${exit_code}` });
    }
    // 2. 备份发布文件夹
    yield backupPublish({ task_name, task_root_path, task_version });
    // 3. 更新任务运行记录
    yield updateTaskExec({ task_name, exit_code, task_version, now_time_str, error_log_list, task_publish_dir }, { G_pool_client, task_root_path });
}

// 更新任务执行记录
function* updateTaskExec({ task_name, exit_code, task_version, now_time_str, error_log_list, task_publish_dir }, { G_pool_client, task_root_path }) {
    var data = yield G_pool_client.query(`select * from t_task_list where task_name='${task_name}'`);
    const { last_start_time, last_end_time, last_warning_time } = data[0];

    // 读取该任务的 日志文件与publish目录下的文件
    var publish_file_list = [];
    const absolute_path_list = yield dir.promiseFiles(task_publish_dir);
    absolute_path_list.map(filePath => { // 将绝对路径转化为相对路径
        var fileName = path.relative(task_publish_dir, filePath);
        publish_file_list.push(path.join(task_name,'history',task_version,fileName));
    });

    const duration = moment(last_end_time).diff(moment(last_start_time), 'seconds');
    const end_time = moment(last_end_time).format('YYYY-MM-DD HH:mm:ss');
    var warning_time;
    if (moment(last_warning_time).isAfter(last_start_time)) {
        warning_time = moment(last_warning_time).format('YYYY-MM-DD HH:mm:ss');
    }
    console.log(`(${task_name}-${task_version})-执行完成，耗时${duration}秒`);
    const sql = mysql.format(`update t_task_exec_list set end_time=?, warning_time=?, exit_code=? , logs=? ,publish_file_list=?,duration=? where task_name='${task_name}' and task_version='${task_version}'`, [end_time, warning_time, exit_code, error_log_list.join('<<<<>>>>'), publish_file_list.toString(), duration])
    yield G_pool_client.query(sql);
}
// 将本次发布文件移动到历史文件目录下，并置空发布文件夹
function* backupPublish({ task_name, task_root_path, task_version }) {
    var task_root_dir = path.join(task_root_path, task_name);
    var task_history_dir = path.join(task_root_dir, 'history');
    var publish_dir = path.join(task_root_dir, 'publish');

    var dest_path = path.join(task_history_dir, task_version);
    var publish_dir_file = fs.readdirSync(publish_dir);
    if (publish_dir_file.length) { // 发布文件夹不为空才进行移动
        console.log(`(${task_name})-版本为${task_version}发布的文件复制到history目录予以备份`);
        fs.copySync(publish_dir, dest_path); // 将上一个版本发布的文件保存
    }
}

module.exports = {
    startExecTask, endExecTask
}