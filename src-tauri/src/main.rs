// Windows 的 release 构建不要弹控制台窗口；debug 构建保留，方便看后端 stdout。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kvm_shell::run()
}
