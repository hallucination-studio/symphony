const CALLBACK_HOST: &str = "127.0.0.1";
const CALLBACK_PORT: u16 = 43821;
const CALLBACK_PATH: &str = "/oauth/linear/callback";

pub(crate) fn fixed_manifest() -> Result<(String, &'static str, u16, &'static str), &'static str> {
    let client_id = std::env::var("LINEAR_CLIENT_ID")
        .map_err(|_| "linear_client_id_missing")?
        .trim()
        .to_owned();
    if client_id.is_empty() {
        return Err("linear_client_id_missing");
    }
    Ok((client_id, CALLBACK_HOST, CALLBACK_PORT, CALLBACK_PATH))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_manifest_uses_the_environment_client_and_fixed_callback() {
        std::env::set_var("LINEAR_CLIENT_ID", "public-client");
        assert_eq!(
            fixed_manifest().unwrap(),
            ("public-client".to_owned(), "127.0.0.1", 43821, "/oauth/linear/callback",)
        );
        std::env::remove_var("LINEAR_CLIENT_ID");
        assert_eq!(fixed_manifest(), Err("linear_client_id_missing"));
    }
}
