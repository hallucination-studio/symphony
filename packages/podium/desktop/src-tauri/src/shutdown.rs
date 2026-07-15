pub trait ShutdownTarget {
    fn shutdown(&mut self) -> Result<(), &'static str>;
}

pub fn shutdown_all(targets: &mut [&mut dyn ShutdownTarget]) -> Vec<&'static str> {
    targets.iter_mut().filter_map(|target| target.shutdown().err()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Target(Result<(), &'static str>);

    impl ShutdownTarget for Target {
        fn shutdown(&mut self) -> Result<(), &'static str> {
            self.0
        }
    }

    #[test]
    fn attempts_every_shutdown_and_returns_each_failure() {
        let mut first = Target(Err("first_shutdown_failed"));
        let mut second = Target(Ok(()));
        let mut third = Target(Err("third_shutdown_failed"));

        let errors = shutdown_all(&mut [&mut first, &mut second, &mut third]);

        assert_eq!(errors, ["first_shutdown_failed", "third_shutdown_failed"]);
    }
}
