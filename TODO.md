INSERT INTO t_task_list (taskName, owner, title, description, rule, command, entryFile, taskStatus, timeout)
    VALUES
     ('clearTaskExecRecord', ${notifyList}, '清理小工具', '清除日志文件与任务执行记录', '0 0 3 * * *', 'node', 'index.js', 0, 60);
