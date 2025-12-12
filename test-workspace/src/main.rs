use std::vec;

struct Token {
    length: u8,
    data: u8,
}

fn main() {
    let tk = vec![
        Token {
            length: 5,
            data: 10,
        },
        Token {
            length: 3,
            data: 20,
        },
        Token {
            length: 8,
            data: 30,
        },
    ];

    for (i, token) in tk.iter().enumerate().peekable() {
        println!(
            "Token {}: length = {}, data = {}",
            i, token.length, token.data
        );
    }
}
